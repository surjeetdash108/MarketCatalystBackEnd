/**
 * Stylesheet of the standard MarketCatalyst blog document (card, eyebrow,
 * subtitle, stat strip, tables, callout, disclaimer). Shared by the D04 analyst
 * calls job and the content pipeline's blog writer.
 */
export const POST_TEMPLATE_CSS = `:where(.post-doc), :where(.post-doc *), :where(.post-doc *::before), :where(.post-doc *::after) { box-sizing: border-box; }
:where(.post-doc) { width: 100%; max-width: 1180px; margin-left: auto; margin-right: auto; padding: 0 clamp(16px, 4vw, 32px); box-sizing: border-box; }
:where(.post-doc img), :where(.post-doc svg), :where(.post-doc video) { max-width: 100%; height: auto; }
:where(.post-doc table) { border-collapse: collapse; }
:where(.post-doc) .post-doc-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; max-width: 100%; }

.post-doc {
  --cream: #F3EFE7;
  --white: #FFFFFF;
  --ink: #1A1A1A;
  --gray-text: #5B6472;
  --blue: #2563EB;
  --border: #E4DFD3;
  --pill-border: #D9D3C4;
  --green: #0F9D58;
  --red: #C0392B;
  background: var(--cream);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: var(--ink);
  margin: 0;
}
.post-doc .card {
  background: var(--white);
  border-radius: 24px;
  padding: 56px 64px 48px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
}
.post-doc .eyebrow {
  color: var(--blue);
  font-weight: 800;
  letter-spacing: 1.5px;
  font-size: 14px;
  margin-bottom: 16px;
  text-transform: uppercase;
}
.post-doc h1 {
  font-size: 40px;
  line-height: 1.15;
  font-weight: 800;
  margin: 0 0 20px;
  letter-spacing: -0.5px;
  color: var(--ink);
}
.post-doc .subtitle {
  color: var(--gray-text);
  font-size: 19px;
  line-height: 1.5;
  margin: 0 0 24px;
  max-width: 720px;
}
.post-doc .meta {
  color: #8A8F98;
  font-size: 14px;
  margin-bottom: 32px;
}
.post-doc hr.rule {
  border: none;
  border-top: 1px solid var(--border);
  margin: 0 0 36px;
}
.post-doc .stat-strip {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  margin: 8px 0 32px;
}
.post-doc .stat-box {
  background: #F7F5EF;
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 18px 16px;
  text-align: center;
}
.post-doc .stat-box .num {
  font-size: 26px;
  font-weight: 800;
  color: var(--blue);
  line-height: 1.1;
}
.post-doc .stat-box .label {
  font-size: 13px;
  color: var(--gray-text);
  margin-top: 6px;
}
.post-doc .callout {
  background: #F7F5EF;
  border: 1px solid var(--border);
  border-left: 4px solid var(--blue);
  border-radius: 10px;
  padding: 18px 22px;
  margin: 24px 0;
  font-size: 16px;
  line-height: 1.6;
}
.post-doc table {
  width: 100%;
  border-collapse: collapse;
  margin: 20px 0 32px;
  font-size: 14px;
}
.post-doc th {
  text-align: left;
  font-size: 12px;
  letter-spacing: 0.5px;
  color: var(--gray-text);
  font-weight: 700;
  padding: 10px 12px;
  border-bottom: 2px solid var(--border);
  text-transform: uppercase;
}
.post-doc td {
  padding: 12px;
  border-bottom: 1px solid var(--border);
  color: var(--ink);
}
.post-doc td.metric { font-weight: 700; }
.post-doc .pos { color: var(--green); font-weight: 700; }
.post-doc .dn { color: var(--red); font-weight: 700; }
.post-doc .disclaimer {
  margin-top: 48px;
  padding-top: 24px;
  border-top: 1px solid var(--border);
  font-size: 12px;
  line-height: 1.6;
  color: #8A8F98;
}
.post-doc .disclaimer a { color: var(--blue); text-decoration: none; }
@media (max-width: 768px) {
  .post-doc .card { padding: 32px 20px; }
  .post-doc .stat-strip { grid-template-columns: 1fr; }
}
`;
