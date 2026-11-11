import { FormEvent, ReactNode, useMemo, useState } from "react";

type Page =
  | "dashboard"
  | "sources"
  | "add-source"
  | "edit-source"
  | "source-detail"
  | "events"
  | "event-detail"
  | "settings";
type IconName =
  | "home"
  | "radio"
  | "layers"
  | "settings"
  | "menu"
  | "x"
  | "arrow"
  | "plus"
  | "file"
  | "clock"
  | "check"
  | "sparkle"
  | "search"
  | "chevron"
  | "more"
  | "external"
  | "mail"
  | "calendar"
  | "edit"
  | "pause"
  | "trash"
  | "alert";

const iconPaths: Record<IconName, ReactNode> = {
  home: (
    <>
      <path d="m3 11 9-8 9 8" />
      <path d="M5 10v10h14V10" />
      <path d="M9 20v-6h6v6" />
    </>
  ),
  radio: (
    <>
      <path d="M4.9 19.1a10 10 0 0 1 0-14.2" />
      <path d="M7.8 16.2a6 6 0 0 1 0-8.4" />
      <circle cx="12" cy="12" r="2" />
      <path d="M16.2 7.8a6 6 0 0 1 0 8.4" />
      <path d="M19.1 4.9a10 10 0 0 1 0 14.2" />
    </>
  ),
  layers: (
    <>
      <path d="m12 2 9 5-9 5-9-5 9-5Z" />
      <path d="m3 12 9 5 9-5" />
      <path d="m3 17 9 5 9-5" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
    </>
  ),
  menu: (
    <>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </>
  ),
  x: <path d="m6 6 12 12M18 6 6 18" />,
  arrow: (
    <>
      <path d="m9 18 6-6-6-6" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  file: (
    <>
      <path d="M6 2h8l4 4v16H6z" />
      <path d="M14 2v5h5M9 12h6M9 16h6" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  sparkle: (
    <>
      <path d="m12 3 1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2L12 3Z" />
      <path d="m18 14 .7 2.3L21 17l-2.3.7L18 20l-.7-2.3L15 17l2.3-.7L18 14Z" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 4 4" />
    </>
  ),
  chevron: <path d="m8 10 4 4 4-4" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  external: (
    <>
      <path d="M14 4h6v6M20 4l-9 9" />
      <path d="M18 13v7H4V6h7" />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M8 3v4M16 3v4M3 10h18" />
    </>
  ),
  edit: (
    <>
      <path d="m4 20 4-.8L19 8.2 15.8 5 4.8 16z" />
      <path d="m14 6.8 3.2 3.2" />
    </>
  ),
  pause: (
    <>
      <path d="M9 5v14M15 5v14" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6" />
    </>
  ),
  alert: (
    <>
      <path d="M12 3 2.8 20h18.4L12 3Z" />
      <path d="M12 9v5M12 17h.01" />
    </>
  ),
};

function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {iconPaths[name]}
    </svg>
  );
}

const events = [
  {
    title: "Bão X đổ bộ khu vực Y, gây mưa lớn diện rộng",
    summary:
      "Bão X đã đổ bộ khu vực Y trong chiều 11/11, gây mưa lớn và ảnh hưởng đến giao thông. Chính quyền địa phương đã ban hành cảnh báo an toàn.",
    sources: "VTV · VnExpress · NHK",
    articles: 3,
    time: "18:42",
  },
  {
    title: "Nhật Bản công bố kế hoạch đầu tư năng lượng mới",
    summary:
      "Chính phủ Nhật Bản công bố gói đầu tư dài hạn nhằm mở rộng năng lượng tái tạo và tăng khả năng tự chủ trong thập kỷ tới.",
    sources: "NHK · Reuters",
    articles: 4,
    time: "16:15",
  },
  {
    title: "Thị trường châu Á phục hồi sau phiên biến động",
    summary:
      "Các chỉ số chính tại châu Á đồng loạt tăng điểm khi tâm lý nhà đầu tư cải thiện nhờ số liệu kinh tế mới.",
    sources: "Reuters · CNN · BBC",
    articles: 5,
    time: "14:28",
  },
  {
    title: "Tuyến đường sắt đô thị mới bắt đầu vận hành thử",
    summary:
      "Tuyến đường sắt đô thị bước vào giai đoạn chạy thử toàn tuyến trước khi đón hành khách vào cuối năm.",
    sources: "Tuổi Trẻ · VnExpress",
    articles: 2,
    time: "11:06",
  },
];

const initialSources = [
  { name: "VTV", domain: "vtv.vn", status: "Active", sync: "2 min ago", articles: 28 },
  { name: "VnExpress", domain: "vnexpress.net", status: "Active", sync: "5 min ago", articles: 41 },
  { name: "NHK", domain: "nhk.or.jp", status: "Active", sync: "3 min ago", articles: 36 },
  { name: "Reuters", domain: "reuters.com", status: "Active", sync: "8 min ago", articles: 52 },
  { name: "CNN", domain: "cnn.com", status: "Disabled", sync: "Yesterday", articles: 0 },
];

function Logo() {
  return (
    <div className="logo">
      <span className="logo-mark">
        <i />
        <i />
        <i />
      </span>
      <span>News Digest</span>
    </div>
  );
}

function Button({
  children,
  variant = "primary",
  icon,
  onClick,
  type = "button",
}: {
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  icon?: IconName;
  onClick?: () => void;
  type?: "button" | "submit";
}) {
  return (
    <button type={type} className={`button button-${variant}`} onClick={onClick}>
      {icon && <Icon name={icon} size={17} />}
      {children}
    </button>
  );
}

function Status({
  label,
  tone = "success",
}: {
  label: string;
  tone?: "success" | "warning" | "error" | "muted" | "info";
}) {
  return (
    <span className={`status status-${tone}`}>
      <span className="status-dot" />
      {label}
    </span>
  );
}

function AiBadge({ children = "AI Clustered" }: { children?: ReactNode }) {
  return (
    <span className="ai-badge">
      <Icon name="sparkle" size={13} />
      {children}
    </span>
  );
}

function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle: string;
  action?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {action && <div className="page-action">{action}</div>}
    </header>
  );
}

function EventCard({
  event,
  onOpen,
  compact = false,
}: {
  event: (typeof events)[number];
  onOpen: () => void;
  compact?: boolean;
}) {
  return (
    <button className={`event-card ${compact ? "event-card-compact" : ""}`} onClick={onOpen}>
      <div className="event-top">
        <AiBadge />
        <span className="event-time">11 Nov · {event.time}</span>
      </div>
      <h3>{event.title}</h3>
      <p>{event.summary}</p>
      <div className="event-meta">
        <span className="event-sources">{event.sources}</span>
        <span>{event.articles} articles</span>
        <Icon name="arrow" size={17} />
      </div>
    </button>
  );
}

function Dashboard({
  navigate,
  openDigest,
}: {
  navigate: (p: Page) => void;
  openDigest: () => void;
}) {
  const stats = [
    {
      icon: "radio" as IconName,
      value: "12",
      label: "Active Sources",
      note: "All sources connected",
    },
    { icon: "file" as IconName, value: "342", label: "Articles Collected", note: "Today" },
    { icon: "layers" as IconName, value: "86", label: "Events Detected", note: "Today" },
    {
      icon: "clock" as IconName,
      value: "07:00",
      label: "Latest Digest",
      note: "Sent successfully",
    },
  ];
  return (
    <>
      <PageHeader
        title="Good morning, News Digest"
        subtitle="Here's what's happening with your news sources."
        action={<Button onClick={openDigest}>View latest digest</Button>}
      />
      <div className="date-line">
        <Icon name="calendar" size={16} /> Wednesday, November 12, 2026
      </div>
      <section className="stats-grid">
        {stats.map((s) => (
          <div className="stat-card" key={s.label}>
            <div className="stat-icon">
              <Icon name={s.icon} />
            </div>
            <div>
              <strong>{s.value}</strong>
              <span>{s.label}</span>
              <small>{s.note}</small>
            </div>
          </div>
        ))}
      </section>
      <div className="dashboard-grid">
        <section>
          <div className="section-heading">
            <div>
              <h2>Latest Events</h2>
              <p>AI-grouped stories from your sources</p>
            </div>
            <button className="text-link" onClick={() => navigate("events")}>
              View all <Icon name="arrow" size={15} />
            </button>
          </div>
          <div className="event-list">
            {events.slice(0, 3).map((event) => (
              <EventCard
                key={event.title}
                event={event}
                compact
                onOpen={() => navigate("event-detail")}
              />
            ))}
          </div>
        </section>
        <aside className="status-panel">
          <div className="section-heading">
            <div>
              <h2>System Status</h2>
              <p>Live service health</p>
            </div>
            <Status label="Operational" />
          </div>
          <div className="health-list">
            {["News Collection", "AI Processing", "Email Delivery"].map((item) => (
              <div className="health-row" key={item}>
                <span>{item}</span>
                <Status label="Healthy" />
              </div>
            ))}
            <div className="health-row">
              <span>Daily Digest</span>
              <Status label="Scheduled" tone="info" />
            </div>
          </div>
          <div className="next-run">
            <div className="next-run-icon">
              <Icon name="clock" />
            </div>
            <div>
              <span>Next digest</span>
              <strong>Tomorrow, 07:00 JST</strong>
              <small>News from November 12</small>
            </div>
          </div>
        </aside>
      </div>
      <section className="digest-banner">
        <div className="digest-symbol">
          <Icon name="mail" size={23} />
        </div>
        <div className="digest-copy">
          <span className="eyebrow">Latest Digest</span>
          <h2>Tin nhanh ngày 11</h2>
          <div>
            <span>12 events</span>
            <i /> <span>07:00 JST</span>
            <i /> <Status label="Sent successfully" />
          </div>
        </div>
        <Button variant="secondary" onClick={openDigest}>
          View digest
        </Button>
      </section>
    </>
  );
}

function Sources({
  navigate,
  sources,
  toggleSource,
}: {
  navigate: (p: Page) => void;
  sources: typeof initialSources;
  toggleSource: (name: string) => void;
}) {
  return (
    <>
      <PageHeader
        title="Sources"
        subtitle="Manage the news sources monitored by your digest."
        action={
          <Button icon="plus" onClick={() => navigate("add-source")}>
            Add Source
          </Button>
        }
      />
      <div className="toolbar">
        <div className="search-box">
          <Icon name="search" size={18} />
          <input aria-label="Search sources" placeholder="Search sources..." />
        </div>
        <button className="filter-button">
          All statuses <Icon name="chevron" size={16} />
        </button>
      </div>
      <section className="table-card">
        <div className="source-table source-head">
          <span>Source</span>
          <span>Status</span>
          <span>Last Sync</span>
          <span>Articles</span>
          <span aria-label="Actions" />
        </div>
        {sources.map((source) => (
          <div className="source-table source-row" key={source.name}>
            <button className="source-name" onClick={() => navigate("source-detail")}>
              <span className="source-avatar">{source.name.slice(0, 2)}</span>
              <span>
                <strong>{source.name}</strong>
                <small>{source.domain}</small>
              </span>
            </button>
            <Status label={source.status} tone={source.status === "Active" ? "success" : "muted"} />
            <span className="cell-muted">{source.sync}</span>
            <span>{source.articles}</span>
            <div className="row-actions">
              <button
                aria-label={`${source.status === "Active" ? "Disable" : "Enable"} ${source.name}`}
                onClick={() => toggleSource(source.name)}
              >
                <Icon name={source.status === "Active" ? "pause" : "check"} size={17} />
              </button>
              <button aria-label={`More actions for ${source.name}`}>
                <Icon name="more" />
              </button>
            </div>
          </div>
        ))}
      </section>
      <p className="table-foot">
        Showing {sources.length} of {sources.length} sources
      </p>
    </>
  );
}

function SourceForm({
  mode = "add",
  navigate,
  saveSource,
}: {
  mode?: "add" | "edit";
  navigate: (p: Page) => void;
  saveSource: (name: string, url: string, mode: "add" | "edit") => void;
}) {
  const [name, setName] = useState(mode === "edit" ? "VnExpress" : "");
  const [url, setUrl] = useState(mode === "edit" ? "https://vnexpress.net" : "");
  const [rss, setRss] = useState(
    mode === "edit" ? "https://vnexpress.net/rss/tin-moi-nhat.rss" : "",
  );
  const [error, setError] = useState("");
  const [enabled, setEnabled] = useState(true);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError("Please enter a source name.");
    if (!/^https?:\/\/.+/.test(url)) return setError("Please enter a valid website URL.");
    saveSource(name, url, mode);
    navigate(mode === "edit" ? "source-detail" : "sources");
  };
  return (
    <>
      <button
        className="back-link"
        onClick={() => navigate(mode === "edit" ? "source-detail" : "sources")}
      >
        <span>←</span> Back to {mode === "edit" ? "source" : "sources"}
      </button>
      <PageHeader
        title={mode === "add" ? "Add Source" : "Edit Source"}
        subtitle={
          mode === "add"
            ? "Add a news source for News Digest to monitor."
            : "Update this source’s collection details."
        }
      />
      <form className="form-card" onSubmit={submit}>
        <div className="form-intro">
          <div className="form-icon">
            <Icon name="radio" />
          </div>
          <div>
            <h2>Source information</h2>
            <p>Enter the website and RSS details for this news source.</p>
          </div>
        </div>
        {error && (
          <div className="alert alert-error" role="alert">
            <Icon name="alert" size={18} />
            <span>{error}</span>
          </div>
        )}
        <label className="field">
          <span>Source name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. VnExpress"
          />
          <small>The name shown throughout your digest.</small>
        </label>
        <label className="field">
          <span>Website URL</span>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com"
            inputMode="url"
          />
        </label>
        <label className="field">
          <span>
            RSS URL <em>Optional</em>
          </span>
          <input
            value={rss}
            onChange={(e) => setRss(e.target.value)}
            placeholder="https://example.com/rss"
            inputMode="url"
          />
          <small>RSS is recommended when available for reliable collection.</small>
        </label>
        <div className="toggle-row">
          <div>
            <strong>Enable source</strong>
            <p>Start collecting articles as soon as this source is added.</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            className={`toggle ${enabled ? "toggle-on" : ""}`}
            onClick={() => setEnabled(!enabled)}
          >
            <span />
          </button>
        </div>
        <div className="form-actions">
          <Button variant="secondary" onClick={() => navigate("sources")}>
            Cancel
          </Button>
          <Button type="submit">{mode === "add" ? "Add Source" : "Save changes"}</Button>
        </div>
      </form>
    </>
  );
}

function SourceDetail({ navigate }: { navigate: (p: Page) => void }) {
  const articles = [
    ["Miền Trung chủ động ứng phó trước diễn biến mới của bão", "11 Nov · 18:42"],
    ["Các hãng hàng không điều chỉnh lịch bay do thời tiết", "11 Nov · 17:10"],
    ["Thị trường phục hồi trong phiên giao dịch buổi chiều", "11 Nov · 14:28"],
  ];
  return (
    <>
      <button className="back-link" onClick={() => navigate("sources")}>
        <span>←</span> Back to sources
      </button>
      <div className="detail-header">
        <div className="detail-identity">
          <span className="source-avatar source-avatar-lg">VN</span>
          <div>
            <div className="title-status">
              <h1>VnExpress</h1>
              <Status label="Active" />
            </div>
            <p>vnexpress.net</p>
          </div>
        </div>
        <div className="header-actions">
          <Button variant="secondary" icon="edit" onClick={() => navigate("edit-source")}>
            Edit
          </Button>
          <Button variant="secondary" icon="pause">
            Disable
          </Button>
        </div>
      </div>
      <div className="detail-grid">
        <section className="info-card">
          <h2>Source information</h2>
          <dl>
            <div>
              <dt>Source name</dt>
              <dd>VnExpress</dd>
            </div>
            <div>
              <dt>Website</dt>
              <dd>
                <a href="https://vnexpress.net" target="_blank" rel="noreferrer">
                  vnexpress.net <Icon name="external" size={14} />
                </a>
              </dd>
            </div>
            <div>
              <dt>RSS feed</dt>
              <dd>rss/tin-moi-nhat.rss</dd>
            </div>
            <div>
              <dt>Last successful sync</dt>
              <dd>2 minutes ago</dd>
            </div>
          </dl>
        </section>
        <section className="collection-card">
          <div className="collection-head">
            <span>Collection Status</span>
            <Status label="Healthy" />
          </div>
          <div className="collection-number">41</div>
          <p>Articles collected today</p>
          <div className="mini-stats">
            <div>
              <span>Last sync</span>
              <strong>2 min ago</strong>
            </div>
            <div>
              <span>Success rate</span>
              <strong>99.8%</strong>
            </div>
          </div>
        </section>
      </div>
      <section className="articles-card">
        <div className="section-heading">
          <div>
            <h2>Recent Articles</h2>
            <p>Latest articles collected from this source</p>
          </div>
        </div>
        {articles.map(([title, date]) => (
          <div className="article-row" key={title}>
            <div>
              <span className="article-icon">
                <Icon name="file" size={17} />
              </span>
              <div>
                <h3>{title}</h3>
                <p>
                  Published {date} · <Status label="Processed" />
                </p>
              </div>
            </div>
            <button className="text-link">
              Open article <Icon name="external" size={14} />
            </button>
          </div>
        ))}
      </section>
    </>
  );
}

function EventsPage({ navigate }: { navigate: (p: Page) => void }) {
  return (
    <>
      <PageHeader
        title="News & Events"
        subtitle="Review collected articles and the events identified by AI."
      />
      <div className="filter-bar">
        <label className="search-box filter-search">
          <Icon name="search" size={18} />
          <input placeholder="Search events..." />
        </label>
        {["11 Nov 2026", "All Sources", "Events", "All statuses"].map((x) => (
          <button className="filter-button" key={x}>
            {x}
            <Icon name="chevron" size={15} />
          </button>
        ))}
      </div>
      <div className="results-heading">
        <div>
          <strong>86 events</strong>
          <span> from 342 articles</span>
        </div>
        <span>Sorted by latest</span>
      </div>
      <div className="event-list event-list-full">
        {events.map((event) => (
          <EventCard key={event.title} event={event} onOpen={() => navigate("event-detail")} />
        ))}
      </div>
    </>
  );
}

function EventDetail({ navigate }: { navigate: (p: Page) => void }) {
  const related = [
    ["VTV", "Bão X gây ảnh hưởng đến nhiều tỉnh miền Trung", "18:20"],
    ["VnExpress", "Bão X đổ bộ, nhiều tuyến đường bị chia cắt", "18:28"],
    ["NHK", "Typhoon X makes landfall in central region", "18:35"],
  ];
  return (
    <>
      <button className="back-link" onClick={() => navigate("events")}>
        <span>←</span> Back to events
      </button>
      <article className="event-detail">
        <div className="event-detail-top">
          <div>
            <AiBadge>AI summarized</AiBadge>
            <h1>Bão X đổ bộ khu vực Y, gây mưa lớn diện rộng</h1>
            <p className="event-detail-meta">11 November 2026 · Last updated 18:42</p>
          </div>
          <button className="icon-button" aria-label="More actions">
            <Icon name="more" />
          </button>
        </div>
        <section className="summary-block">
          <div className="summary-label">
            <Icon name="sparkle" size={16} /> Summary
          </div>
          <p>
            Bão X đã đổ bộ khu vực Y trong chiều ngày 11/11, gây mưa lớn trên diện rộng và ảnh hưởng
            đến hoạt động giao thông. Chính quyền địa phương đã phát đi cảnh báo, đồng thời sơ tán
            người dân tại các khu vực có nguy cơ sạt lở và ngập sâu. Các chuyến bay trong khu vực
            đang được điều chỉnh để bảo đảm an toàn.
          </p>
        </section>
        <div className="confidence-row">
          <div>
            <span>AI confidence</span>
            <strong>94%</strong>
          </div>
          <div className="confidence-track">
            <span />
          </div>
          <div>
            <span>Articles grouped</span>
            <strong>3</strong>
          </div>
        </div>
      </article>
      <div className="event-detail-grid">
        <section className="articles-card related-card">
          <div className="section-heading">
            <div>
              <h2>Related Articles</h2>
              <p>3 articles grouped into this event</p>
            </div>
          </div>
          {related.map(([source, title, time]) => (
            <div className="related-article" key={title}>
              <span className="source-avatar">{source.slice(0, 2)}</span>
              <div>
                <span className="related-source">{source}</span>
                <h3>{title}</h3>
                <p>Published at {time}</p>
              </div>
              <a href="#" aria-label={`Read ${title}`}>
                <Icon name="external" size={17} />
              </a>
            </div>
          ))}
        </section>
        <aside className="sources-card">
          <h2>Sources</h2>
          <p>3 independent sources reported this event.</p>
          {["VTV", "VnExpress", "NHK"].map((s) => (
            <button key={s}>
              <span className="source-avatar">{s.slice(0, 2)}</span>
              <span>
                {s}
                <small>View source</small>
              </span>
              <Icon name="arrow" size={16} />
            </button>
          ))}
        </aside>
      </div>
    </>
  );
}

function SettingsPage({ onPreview }: { onPreview: () => void }) {
  const [saved, setSaved] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaved(true);
    window.setTimeout(() => setSaved(false), 3000);
  };
  return (
    <>
      <PageHeader title="Settings" subtitle="Manage your digest delivery and preferences." />
      {saved && (
        <div className="toast" role="status">
          <span>
            <Icon name="check" size={16} />
          </span>
          <div>
            <strong>Settings saved</strong>
            <p>Your digest preferences were updated successfully.</p>
          </div>
          <button onClick={() => setSaved(false)} aria-label="Close">
            <Icon name="x" size={17} />
          </button>
        </div>
      )}
      <form className="settings-layout" onSubmit={submit}>
        <section className="settings-card">
          <div className="settings-heading">
            <span>
              <Icon name="mail" />
            </span>
            <div>
              <h2>Digest Settings</h2>
              <p>Choose where and when your daily briefing is delivered.</p>
            </div>
          </div>
          <label className="field">
            <span>Email address</span>
            <input type="email" defaultValue="your@email.com" />
            <small>Your Daily Digest will be delivered to this address.</small>
          </label>
          <div className="field-pair">
            <label className="field">
              <span>Timezone</span>
              <select defaultValue="Asia/Tokyo">
                <option>Asia/Tokyo</option>
                <option>Asia/Ho_Chi_Minh</option>
                <option>Europe/London</option>
              </select>
            </label>
            <label className="field">
              <span>Send time</span>
              <input type="time" defaultValue="07:00" />
            </label>
          </div>
          <div className="info-note">
            <Icon name="calendar" size={18} />
            <p>
              Your Daily Digest contains news from the previous calendar day in your selected
              timezone.
            </p>
          </div>
          <div className="form-actions settings-actions">
            <Button type="submit">Save Changes</Button>
          </div>
        </section>
        <aside className="preview-card">
          <div className="preview-mail">
            <span className="mail-line short" />
            <span className="mail-line" />
            <span className="mail-line" />
            <div>
              <span />
              <span />
            </div>
            <span className="mail-line" />
          </div>
          <h2>Preview Daily Digest</h2>
          <p>See exactly how tomorrow's briefing will look in your inbox.</p>
          <Button variant="secondary" onClick={onPreview}>
            Preview Email
          </Button>
        </aside>
      </form>
    </>
  );
}

function EmailPreview({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Daily digest preview"
    >
      <div className="email-modal">
        <div className="modal-toolbar">
          <div>
            <span className="window-dot" />
            <span className="window-dot" />
            <span className="window-dot" />
          </div>
          <span>Email preview</span>
          <button onClick={onClose} aria-label="Close preview">
            <Icon name="x" />
          </button>
        </div>
        <div className="email-canvas">
          <div className="email-shell">
            <div className="email-brand">
              <Logo />
              <span>11 November 2026</span>
            </div>
            <div className="email-hero">
              <span>DAILY BRIEFING</span>
              <h1>Tin nhanh ngày 11</h1>
              <p>Những sự kiện đáng chú ý trong ngày, được tổng hợp từ các nguồn bạn tin cậy.</p>
            </div>
            <div className="email-count">
              <strong>12 sự kiện</strong>
              <span>Thứ Ba, 11 tháng 11</span>
            </div>
            {events.slice(0, 3).map((event, i) => (
              <article className="email-event" key={event.title}>
                <span className="email-index">0{i + 1}</span>
                <div>
                  <h2>{event.title}</h2>
                  <p className="email-source">
                    {event.sources} · {event.time}
                  </p>
                  <p>{event.summary}</p>
                  <a href="#">
                    Đọc nguồn <span>→</span>
                  </a>
                </div>
              </article>
            ))}
            <footer className="email-footer">
              <Logo />
              <p>You're receiving this email because you configured a Daily News Digest.</p>
              <a href="#">Manage your preferences</a>
            </footer>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [page, setPage] = useState<Page>("dashboard");
  const [drawer, setDrawer] = useState(false);
  const [digestOpen, setDigestOpen] = useState(false);
  const [sources, setSources] = useState(initialSources);
  const navItems = useMemo(
    () => [
      { page: "dashboard" as Page, label: "Dashboard", icon: "home" as IconName },
      { page: "sources" as Page, label: "Sources", icon: "radio" as IconName },
      { page: "events" as Page, label: "News & Events", icon: "layers" as IconName },
      { page: "settings" as Page, label: "Settings", icon: "settings" as IconName },
    ],
    [],
  );
  const navigate = (next: Page) => {
    setPage(next);
    setDrawer(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const activePage =
    page === "add-source" || page === "edit-source" || page === "source-detail"
      ? "sources"
      : page === "event-detail"
        ? "events"
        : page;
  const addSource = (name: string, url: string) =>
    setSources((current) =>
      current.some((s) => s.name === name)
        ? current
        : [
            ...current,
            {
              name,
              domain: url.replace(/^https?:\/\//, "").replace(/\/.*$/, ""),
              status: "Active",
              sync: "Just now",
              articles: 0,
            },
          ],
    );
  const saveSource = (name: string, url: string, mode: "add" | "edit") => {
    if (mode === "add") {
      addSource(name, url);
      return;
    }
    setSources((current) =>
      current.map((source) =>
        source.name === "VnExpress"
          ? {
              ...source,
              name,
              domain: url.replace(/^https?:\/\//, "").replace(/\/.*$/, ""),
              sync: "Just now",
            }
          : source,
      ),
    );
  };
  const toggleSource = (name: string) =>
    setSources((current) =>
      current.map((s) =>
        s.name === name ? { ...s, status: s.status === "Active" ? "Disabled" : "Active" } : s,
      ),
    );
  return (
    <div className="app-shell">
      <header className="mobile-header">
        <Logo />
        <button onClick={() => setDrawer(true)} aria-label="Open menu">
          <Icon name="menu" />
        </button>
      </header>
      <aside className={`sidebar ${drawer ? "sidebar-open" : ""}`}>
        <div className="sidebar-top">
          <Logo />
          <button className="drawer-close" onClick={() => setDrawer(false)} aria-label="Close menu">
            <Icon name="x" />
          </button>
        </div>
        <p className="sidebar-tagline">Read less. Know more.</p>
        <nav>
          {navItems.map((item) => (
            <button
              key={item.page}
              className={activePage === item.page ? "active" : ""}
              onClick={() => navigate(item.page)}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
              {activePage === item.page && <i />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sync-card">
            <span>
              <Icon name="check" size={15} />
            </span>
            <div>
              <strong>All systems healthy</strong>
              <small>Last checked just now</small>
            </div>
          </div>
          <button className="profile">
            <span>ND</span>
            <div>
              <strong>News Digest</strong>
              <small>Personal workspace</small>
            </div>
            <Icon name="more" />
          </button>
        </div>
      </aside>
      {drawer && (
        <button
          className="drawer-backdrop"
          onClick={() => setDrawer(false)}
          aria-label="Close menu"
        />
      )}
      <main className="main-content">
        {page === "dashboard" && (
          <Dashboard navigate={navigate} openDigest={() => setDigestOpen(true)} />
        )}
        {page === "sources" && (
          <Sources navigate={navigate} sources={sources} toggleSource={toggleSource} />
        )}
        {page === "add-source" && <SourceForm navigate={navigate} saveSource={saveSource} />}
        {page === "edit-source" && (
          <SourceForm mode="edit" navigate={navigate} saveSource={saveSource} />
        )}
        {page === "source-detail" && <SourceDetail navigate={navigate} />}
        {page === "events" && <EventsPage navigate={navigate} />}
        {page === "event-detail" && <EventDetail navigate={navigate} />}
        {page === "settings" && <SettingsPage onPreview={() => setDigestOpen(true)} />}
      </main>
      {digestOpen && <EmailPreview onClose={() => setDigestOpen(false)} />}
    </div>
  );
}
