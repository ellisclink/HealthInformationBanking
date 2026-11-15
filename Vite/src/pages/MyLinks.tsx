import { useEffect, useState } from "react";
import NavigationBar from "../components/NavigationBar";
import { listLinks, createLink, updateLink, removeLink, linkOpened } from "../data/links";
import type { Link, LinkInput } from "../data/links";

// Personal Link Repository: the patient's health-related websites in one place —
// insurance portal, pharmacy, patient portals, lab results sites, device apps.
// Links and phone numbers only; passwords are never stored. Read and saved with the Parse SDK (data/links.ts).

type Draft = LinkInput;

const CATEGORIES: [string, string][] = [
  ["insurance", "Insurance"], ["pharmacy", "Pharmacy"], ["patient_portal", "Patient portal"],
  ["lab_results", "Lab results"], ["provider", "Doctor / clinic"], ["telehealth", "Telehealth"],
  ["device_app", "Device app"], ["other", "Other"],
];
const categoryLabel = (c: string) => CATEGORIES.find(([k]) => k === c)?.[1] ?? c;
const emptyDraft: Draft = { title: "", url: "", category: "insurance", organization: "", phone: "", member_id_hint: "", notes: "", is_favorite: false };
const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };

function MyLinks() {
  const [links, setLinks] = useState<Link[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [filter, setFilter] = useState("");

  async function load() {
    setLinks(await listLinks());
  }
  useEffect(() => {
    listLinks().then(setLinks)
      .catch((e) => setError((e as Error).message)).finally(() => setLoading(false));
  }, []);

  async function act(work: () => Promise<string | void>) {
    setBusy(true); setError(""); setMessage("");
    try { const msg = await work(); await load(); if (msg) setMessage(msg); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  function startAdd() { setDraft(emptyDraft); setEditing("new"); setError(""); setMessage(""); }
  function startEdit(l: Link) {
    setDraft({ title: l.title, url: l.url, category: l.category, organization: l.organization ?? "", phone: l.phone ?? "",
      member_id_hint: l.member_id_hint ?? "", notes: l.notes ?? "", is_favorite: l.is_favorite });
    setEditing(l.link_id); setError(""); setMessage("");
  }

  function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.title.trim() || !draft.url.trim()) { setError("Enter a name and a web address."); return; }
    const body = { ...draft, title: draft.title.trim(), url: draft.url.trim() };
    act(async () => {
      if (editing === "new") await createLink(body);
      else if (editing) await updateLink(editing, body);
      setEditing(null);
      return `${body.title} saved.`;
    });
  }

  const toggleFavorite = (l: Link) => act(async () => {
    await updateLink(l.link_id, { is_favorite: !l.is_favorite });
  });
  const remove = (l: Link) => {
    if (!window.confirm(`Delete the link "${l.title}"?`)) return;
    act(async () => { await removeLink(l.link_id); return `${l.title} deleted.`; });
  };
  // count the visit; the link itself opens normally (new tab)
  const opened = (l: Link) => { linkOpened(l).catch(() => {}); };

  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setDraft((d) => ({ ...d, [k]: e.target.value }));

  const shown = filter ? links.filter((l) => l.category === filter) : links;
  const favorites = shown.filter((l) => l.is_favorite);
  const groups = CATEGORIES.map(([key, label]) => ({ key, label, items: shown.filter((l) => !l.is_favorite && l.category === key) }))
    .filter((g) => g.items.length);

  const card = (l: Link) => (
    <article key={l.link_id} className="link-card">
      <div className="link-main">
        <button type="button" className={`link-star ${l.is_favorite ? "on" : ""}`} disabled={busy}
          aria-pressed={l.is_favorite} aria-label={l.is_favorite ? `Remove ${l.title} from favorites` : `Add ${l.title} to favorites`}
          onClick={() => toggleFavorite(l)}>{l.is_favorite ? "★" : "☆"}</button>
        <div>
          <h4><a href={l.url} target="_blank" rel="noopener noreferrer" onClick={() => opened(l)}>{l.title}</a></h4>
          <p className="shared-sub">
            {host(l.url)}{l.organization && ` · ${l.organization}`}{" · "}{categoryLabel(l.category)}
          </p>
          {(l.phone || l.member_id_hint) && (
            <p className="link-meta">
              {l.phone && <>Phone: <a href={`tel:${l.phone.replace(/[^\d+]/g, "")}`}>{l.phone}</a></>}
              {l.phone && l.member_id_hint && " · "}
              {l.member_id_hint && <>Member ID ends in {l.member_id_hint}</>}
            </p>
          )}
          {l.notes && <p className="link-notes">{l.notes}</p>}
        </div>
      </div>
      <div className="med-manage">
        <a className="secondary-button link-open" href={l.url} target="_blank" rel="noopener noreferrer" onClick={() => opened(l)}>Open ↗</a>
        <button type="button" className="text-button med-link" onClick={() => startEdit(l)}>Edit</button>
        <button type="button" className="text-button med-link danger" disabled={busy} onClick={() => remove(l)}>Delete</button>
      </div>
    </article>
  );

  return (
    <>
      <NavigationBar />
      <main className="page-container">
        <section className="page-heading">
          <h2>My Links</h2>
          <p>Your insurance, pharmacy and patient portal websites in one place.</p>
        </section>

        {error && <p className="notice error" role="alert">{error}</p>}
        {message && !error && <p className="notice success" role="status">{message}</p>}

        <div className="med-toolbar">
          <button className="primary-button" type="button" onClick={() => (editing ? setEditing(null) : startAdd())}>
            {editing ? "Cancel" : "+ Add Link"}
          </button>
          <label className="med-filter">Show
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="">All</option>
              {CATEGORIES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
        </div>

        {editing && (
          <form className="med-add" onSubmit={save} noValidate>
            <h3>{editing === "new" ? "Add a link" : "Edit link"}</h3>
            <div className="med-add-grid">
              <label>Name *<input value={draft.title} onChange={set("title")} placeholder="e.g. Example Health Plan member portal" /></label>
              <label>Web address *<input value={draft.url} onChange={set("url")} placeholder="e.g. example.com" inputMode="url" /></label>
              <label>Type<select value={draft.category} onChange={set("category")}>
                {CATEGORIES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
              <label>Organization<input value={draft.organization} onChange={set("organization")} placeholder="e.g. CVS on Glades Rd" /></label>
              <label>Phone<input value={draft.phone} onChange={set("phone")} placeholder="(561) 555-0100" inputMode="tel" /></label>
              <label>Member ID (last 4 only)<input value={draft.member_id_hint} onChange={set("member_id_hint")} maxLength={6} placeholder="e.g. 4821" /></label>
              <label className="med-wide">Notes<input value={draft.notes} onChange={set("notes")} placeholder="e.g. use for refills; open 24 hours" /></label>
              <label className="link-fav"><input type="checkbox" checked={draft.is_favorite}
                onChange={(e) => setDraft((d) => ({ ...d, is_favorite: e.target.checked }))} /> Favorite (show at the top)</label>
            </div>
            <p className="form-hint">Never save passwords here. Your browser or a password manager is the safe place for those.</p>
            <button className="primary-button" type="submit" disabled={busy}>{busy ? "Saving…" : "Save Link"}</button>
          </form>
        )}

        {loading ? <p role="status">Loading links…</p> : shown.length === 0 ? (
          <p>{links.length ? "No links of this type." : 'No links yet. Click "+ Add Link" to save your insurance portal, pharmacy and more.'}</p>
        ) : (
          <>
            {favorites.length > 0 && (
              <section className="link-group">
                <h3>Favorites</h3>
                <div className="link-grid">{favorites.map(card)}</div>
              </section>
            )}
            {groups.map((g) => (
              <section key={g.key} className="link-group">
                <h3>{g.label}</h3>
                <div className="link-grid">{g.items.map(card)}</div>
              </section>
            ))}
          </>
        )}
      </main>
    </>
  );
}

export default MyLinks;
