import type { RecordSummary } from "../types";

export function authorLine(authors: string[]): string {
  if (!authors.length) return "No authors listed";
  return authors.slice(0, 5).join(", ") + (authors.length > 5 ? ` and ${authors.length - 5} more` : "");
}

export function RecordDetails({ record }: { record: RecordSummary }) {
  return (
    <div className="record">
      <p className="record-title">{record.title}</p>
      <p className="record-meta">
        {authorLine(record.authors)}
        {record.year ? ` · ${record.year}` : ""}
        {record.container ? ` · ${record.container}` : ""}
      </p>
      {record.doi && (
        <p className="record-meta">
          DOI:{" "}
          <a href={`https://doi.org/${record.doi}`} target="_blank" rel="noopener noreferrer">
            {record.doi}
          </a>
          {" · "}source: {record.provider}
        </p>
      )}
    </div>
  );
}
