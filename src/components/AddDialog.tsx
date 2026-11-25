import { FileUp, Search, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Collection } from "../types";
import { CheckPanel } from "./CheckPanel";
import { FindPanel } from "./FindPanel";
import { ImportPanel } from "./ImportPanel";
import { TrustKey } from "./TrustLabel";

type Tab = "search" | "check" | "import";

interface Props {
  projectId: string;
  collection: Collection | null;
  initialTab?: Tab;
  onClose: () => void;
  onAdded: () => void;
}

const TABS: { id: Tab; label: string; icon: typeof Search }[] = [
  { id: "search", label: "Search databases", icon: Search },
  { id: "check", label: "Check a reference", icon: ShieldCheck },
  { id: "import", label: "Import file", icon: FileUp },
];

export function AddDialog({ projectId, collection, initialTab = "search", onClose, onAdded }: Props) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    ref.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="add-title" ref={ref} tabIndex={-1}>
        <div className="dialog-head">
          <h2 id="add-title">Add references</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}><X size={20} /></button>
        </div>
        <div className="dialog-tabs" role="tablist" aria-label="How to add">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "dtab dtab-on" : "dtab"} onClick={() => setTab(id)}>
              <Icon size={16} aria-hidden="true" /> {label}
            </button>
          ))}
        </div>
        {collection && <p className="dialog-note">Sources you approve are also filed in <b>{collection.name}</b>.</p>}
        <div className="dialog-body">
          {tab === "search" && <FindPanel projectId={projectId} onAdded={onAdded} collectionId={collection?.id} />}
          {tab === "check" && <CheckPanel projectId={projectId} onAdded={onAdded} collectionId={collection?.id} />}
          {tab === "import" && <ImportPanel projectId={projectId} onAdded={onAdded} collectionId={collection?.id} />}
          <details className="dialog-key">
            <summary>What the trust labels mean</summary>
            <TrustKey />
          </details>
        </div>
      </div>
    </div>
  );
}
