import { digestDisplayDate, digestSubject, EMPTY_DIGEST_MESSAGE } from "@aidnd/domain";
import type { DigestSnapshotEvent } from "@aidnd/contracts";

export type DigestEmailModel = {
  localDate: string;
  events: DigestSnapshotEvent[];
};

export type RenderedDigestEmail = {
  subject: string;
  displayDate: string;
  html: string;
  text: string;
};

const EMPTY_FOLLOW_UP = "Hệ thống sẽ tiếp tục theo dõi và gửi bản tin vào ngày mai.";
const COLORS = { primary: "#3157d5", text: "#101828", secondary: "#475467", muted: "#667085", border: "#e4e7ec", canvas: "#f2f4f7" };

/** Escapes untrusted text (Article/Event/Source values) for HTML text and attributes. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Only absolute http(s) URLs are rendered as links; anything else is dropped. */
export function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function jstTime(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return `${new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false }).format(date)} JST`;
}

function uniqueSources(event: DigestSnapshotEvent): string[] {
  return Array.from(new Set(event.sources.map((name) => name.trim()).filter(Boolean)));
}

function renderEvent(event: DigestSnapshotEvent): string {
  const index = String(event.position).padStart(2, "0");
  const links = event.articles
    .map((article) => {
      const url = safeHttpUrl(article.originalUrl);
      if (!url) return "";
      const time = jstTime(article.publishedAt);
      return `<tr><td style="padding:3px 0;font-size:13px;line-height:19px;">
        <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" style="color:${COLORS.primary};font-weight:600;text-decoration:none;">${escapeHtml(article.sourceName)}</a>
        <span style="color:${COLORS.secondary};"> — ${escapeHtml(article.originalTitle)}</span>${time ? `<span style="color:${COLORS.muted};font-size:12px;"> · ${time}</span>` : ""}
      </td></tr>`;
    })
    .join("");

  return `<tr><td style="padding:24px 0;border-bottom:1px solid ${COLORS.border};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td width="34" valign="top" style="font-family:'Times New Roman',Times,serif;font-size:13px;color:${COLORS.muted};padding-top:3px;">${index}</td>
      <td valign="top">
        <h2 style="margin:0;font-family:'Times New Roman',Times,serif;font-size:19px;line-height:26px;color:${COLORS.text};">📰 ${escapeHtml(event.titleVi)}</h2>
        <p style="margin:8px 0 0;font-size:12px;line-height:18px;color:${COLORS.muted};"><strong style="color:${COLORS.secondary};">Nguồn:</strong> ${escapeHtml(uniqueSources(event).join(" · "))}</p>
        <p style="margin:12px 0 0;font-size:14px;line-height:22px;color:${COLORS.secondary};"><strong>Tóm tắt:</strong> ${escapeHtml(event.summaryVi)}</p>
        ${links ? `<p style="margin:14px 0 4px;font-size:12px;font-weight:700;color:${COLORS.text};">Đọc nguồn:</p><table role="presentation" cellpadding="0" cellspacing="0" border="0">${links}</table>` : ""}
      </td>
    </tr></table>
  </td></tr>`;
}

function renderText(model: DigestEmailModel, displayDate: string): string {
  const lines = ["News Digest", `Tin nhanh ngày ${displayDate}`, "", "Tổng hợp các sự kiện nổi bật trong ngày.", ""];
  if (model.events.length === 0) {
    lines.push(EMPTY_DIGEST_MESSAGE, EMPTY_FOLLOW_UP);
  }
  for (const event of model.events) {
    lines.push(`${event.position}. ${event.titleVi}`, `Nguồn: ${uniqueSources(event).join(" · ")}`, `Tóm tắt: ${event.summaryVi}`, "Đọc nguồn:");
    for (const article of event.articles) {
      const url = safeHttpUrl(article.originalUrl);
      if (url) lines.push(`- ${article.sourceName}: ${url}`);
    }
    lines.push("");
  }
  lines.push("—", "Bạn nhận email này vì đã cấu hình AI Daily News Digest.");
  return lines.join("\n");
}

/** Single renderer for the real email and the in-app preview. */
export function renderDigestEmail(model: DigestEmailModel): RenderedDigestEmail {
  const subject = digestSubject(model.localDate);
  const displayDate = digestDisplayDate(model.localDate);
  const eventCount = model.events.length;
  const body =
    eventCount === 0
      ? `<tr><td style="padding:40px 8px;text-align:center;border-bottom:1px solid ${COLORS.border};">
          <h2 style="margin:0;font-family:'Times New Roman',Times,serif;font-size:20px;color:${COLORS.text};">${escapeHtml(EMPTY_DIGEST_MESSAGE)}</h2>
          <p style="margin:10px 0 0;font-size:13px;line-height:20px;color:${COLORS.muted};">${escapeHtml(EMPTY_FOLLOW_UP)}</p>
        </td></tr>`
      : model.events.map(renderEvent).join("");

  const html = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${COLORS.canvas};-webkit-text-size-adjust:100%;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COLORS.canvas};">
<tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${COLORS.text};">
    <tr><td style="padding:28px 32px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-bottom:1px solid ${COLORS.border};"><tr>
        <td style="padding-bottom:20px;font-size:15px;font-weight:700;color:${COLORS.text};"><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${COLORS.primary};margin-right:8px;"></span>News Digest</td>
        <td align="right" style="padding-bottom:20px;font-size:12px;color:${COLORS.muted};">${displayDate}</td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:28px 32px 20px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:0.13em;color:${COLORS.primary};">BẢN TIN HẰNG NGÀY</div>
      <h1 style="margin:8px 0 0;font-family:'Times New Roman',Times,serif;font-size:30px;line-height:38px;font-weight:600;color:${COLORS.text};">Tin nhanh ngày ${displayDate}</h1>
      <p style="margin:8px 0 0;font-size:14px;line-height:21px;color:${COLORS.secondary};">Tổng hợp các sự kiện nổi bật trong ngày.</p>
    </td></tr>
    <tr><td style="padding:0 32px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="padding:10px 0;border-top:2px solid ${COLORS.text};border-bottom:1px solid ${COLORS.border};font-size:12px;font-weight:700;">${eventCount} sự kiện</td></tr>
        ${body}
      </table>
    </td></tr>
    <tr><td style="padding:22px 32px;background:#f8f9fb;font-size:12px;line-height:18px;color:${COLORS.muted};">
      <strong style="color:${COLORS.text};">News Digest</strong><br>
      Bạn nhận email này vì đã cấu hình AI Daily News Digest. Bản tin được gửi lúc 07:00 (giờ Tokyo) mỗi ngày.
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;

  return { subject, displayDate, html, text: renderText(model, displayDate) };
}
