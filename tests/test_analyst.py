"""The Analyst is plain code: relevance by TF-IDF, sentences sorted by cue words, the
study design from method cues. Every sentence it returns is the paper's own."""
from backend import analyst

ABS = ("We examine whether working from home changes employee performance. We randomly assigned 249 call-centre "
       "employees to work from home or in the office for nine months. Home working led to a 13% performance increase. "
       "However, the results may not generalise beyond call centres.")


def test_sentences_are_sorted_and_kept_verbatim():
    s = analyst.sort_sentences(ABS)
    assert s["aim"] == ["We examine whether working from home changes employee performance."]
    assert "randomly assigned 249" in s["method"][0]
    assert s["findings"] == ["Home working led to a 13% performance increase."]
    assert s["limits"][0].startswith("However, the results may not generalise")
    for part in s.values():
        for sentence in part:
            assert sentence in ABS


def test_design_and_relevance():
    assert analyst.design_of(ABS) == "Randomised experiment"
    assert analyst.design_of("A systematic review and meta-analysis of 40 trials") == "Meta-analysis / systematic review"
    docs = [analyst.tokens("Working from home and employee performance " + ABS),
            analyst.tokens("Deep learning for object recognition in images")]
    q = analyst.tokens("Does working from home change employee performance?")
    v = analyst.tfidf_vectors(docs + [q])
    assert analyst.cosine(v[0], v[2]) > analyst.cosine(v[1], v[2]) == 0


def test_analyse_ranks_by_relevance(monkeypatch):
    def fake_fetch(client, dois):
        return {"10.1/home": {"abstract_inverted_index": {w: [i] for i, w in enumerate(ABS.split(" "))}, "cited_by_count": 50},
                "10.1/dl": {"abstract_inverted_index": None, "cited_by_count": 9000}}
    monkeypatch.setattr(analyst, "fetch_works", fake_fetch)
    out = analyst.analyse(None, "Does working from home change employee performance?", "",
                          [{"doi": "10.1/dl", "title": "Deep learning"}, {"doi": "10.1/home", "title": "Working from home"}],
                          ["Home working raised performance by 13%."])
    assert [r["doi"] for r in out["results"]] == ["10.1/home", "10.1/dl"]
    assert out["results"][0]["relevance_pct"] == 100 and out["results"][1]["has_abstract"] is False
    assert out["claims"][0]["best"][0]["doi"] == "10.1/home"
