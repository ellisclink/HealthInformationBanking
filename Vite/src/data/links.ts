// links.ts — the only browser file that reads and writes PersonalLink (My Links), with the Parse SDK. Cloud Code
// triggers (RULES.PersonalLink in Parse/cloud/lib/access.js) guard every request: own rows only, patients only, the
// field rules of links.js (http/https only, no username/password in a link, short member ID hint), at most 200 links,
// no duplicate url, and the audit log.
//   - never send user_id (the server sets it); never send last_opened_at (the server sets it when a link is opened)
//   - send the owner ACL on create only (the server overwrites it); never on update (a changed ACL is refused)
//   - plain values only; booleans as booleans; clearing a field = unset
//   - opening a link = an update that sends ONLY open_count (the server adds 1 to the stored count, atomically, and sets the time)
import Parse from "../parse";
import { run } from "./parseCall";
import { MAX_ROWS, ownerAcl, isBlank, textOrNull, isoOrText } from "./common";

// a saved link as the page shows it (the old /links row; link_id is the Parse objectId)
export type Link = {
  link_id: string; title: string; url: string; category: string; organization: string | null;
  phone: string | null; member_id_hint: string | null; notes: string | null; is_favorite: boolean;
  open_count: number; last_opened_at: string | null;
};
// what the page's form sends ("" = not set)
export type LinkInput = {
  title: string; url: string; category: string; organization: string; phone: string; member_id_hint: string; notes: string;
  is_favorite: boolean;
};



// result.id, not result.get("objectId") (undefined: the id is not an attribute)
function toLink(o: Parse.Object): Link {
  const count = o.get("open_count");
  return {
    link_id: o.id, title: o.get("title") || "", url: o.get("url") || "", category: o.get("category") || "other",
    organization: textOrNull(o.get("organization")), phone: textOrNull(o.get("phone")),
    member_id_hint: textOrNull(o.get("member_id_hint")), notes: textOrNull(o.get("notes")),
    is_favorite: o.get("is_favorite") === true, open_count: typeof count === "number" && Number.isFinite(count) ? count : 0,
    last_opened_at: isoOrText(o.get("last_opened_at")),
  };
}

// the old list(): favorites first, then by category, then by title (case-insensitive)
export function sortLinks(rows: Link[]): Link[] {
  return rows.sort((a, b) => (b.is_favorite ? 1 : 0) - (a.is_favorite ? 1 : 0) || a.category.localeCompare(b.category)
    || a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
}

export function listLinks(category?: string): Promise<Link[]> {
  return run(async () => {
    const q = new Parse.Query("PersonalLink").limit(MAX_ROWS);
    if (category) q.equalTo("category", category);
    return sortLinks((await q.find()).map(toLink));
  });
}

// create(): blank fields are not sent; the server sets user_id, the ACL and the defaults (category other, not a favorite, 0 opens)
export function createLink(input: LinkInput): Promise<void> {
  return run(async () => {
    const obj = new Parse.Object("PersonalLink");
    for (const [k, v] of Object.entries(input)) if (!isBlank(v)) obj.set(k, v);
    obj.setACL(ownerAcl());
    await obj.save();
  });
}

// update(): only the fields given; "" or null clears the field (unset); false is sent as false
export function updateLink(id: string, input: Partial<LinkInput>): Promise<void> {
  return run(async () => {
    const obj = new Parse.Object("PersonalLink");
    obj.id = id;
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined) continue;
      if (v === null || v === "") obj.unset(k);
      else obj.set(k, v);
    }
    await obj.save();
  });
}

export function removeLink(id: string): Promise<void> {
  return run(async () => {
    const obj = new Parse.Object("PersonalLink");
    obj.id = id;
    await obj.destroy();
  });
}

// the old POST /links/:id/opened: counts one visit (the server ignores the number sent and adds 1 to the stored count)
export function linkOpened(link: Link): Promise<void> {
  return run(async () => {
    const obj = new Parse.Object("PersonalLink");
    obj.id = link.link_id;
    obj.set("open_count", link.open_count + 1);
    await obj.save();
  });
}
