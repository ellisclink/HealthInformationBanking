import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { EFFECTIVE_DATE, LEGAL_DRAFT, SITE_NAME, TERMS_VERSION } from "../legal";

// The frame around the Terms and the Privacy Policy: title, version, a draft warning (until legal.ts says otherwise) and a contents list.
function LegalLayout({ title, sections, children }: { title: string; sections: { id: string; title: string }[]; children: ReactNode }) {
  return (
    <main className="page-container legal-page">
      <section className="page-heading">
        <h2>{title}</h2>
        <p>{SITE_NAME} · Effective {EFFECTIVE_DATE} · Version {TERMS_VERSION}</p>
      </section>

      {LEGAL_DRAFT && (
        <p className="notice error" role="status">
          This document is a draft and has not yet been reviewed by a lawyer. Do not rely on it as final.
        </p>
      )}

      <nav aria-label="Contents" className="legal-toc">
        <strong>Contents</strong>
        <ol>{sections.map((s) => <li key={s.id}><a href={`#${s.id}`}>{s.title}</a></li>)}</ol>
      </nav>

      <article className="legal-body">{children}</article>

      <p className="auth-switch no-print"><Link to="/">Back to {SITE_NAME}</Link></p>
    </main>
  );
}

export default LegalLayout;
