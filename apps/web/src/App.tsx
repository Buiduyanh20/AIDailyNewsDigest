import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  DashboardSummary,
  DigestListResponse,
  DigestPreviewResponse,
  DigestSummary,
  EventDetailResponse,
  EventListResponse,
  SettingsResponse,
} from "@aidnd/contracts";

type AuthState =
  | { status: "loading" }
  | { status: "authenticated"; user: { id: string; email: string } }
  | { status: "unauthenticated" };

type LoginState = "idle" | "loading" | "error" | "rate-limited" | "server-error" | "success";
type NavKey = "/" | "/sources" | "/events" | "/settings";
type SourceStatus = "active" | "disabled" | "error";

type Source = {
  id: string;
  userId: string;
  name: string;
  websiteUrl: string;
  rssUrl: string | null;
  enabled: boolean;
  status: SourceStatus;
  lastFetchedAt: string | null;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type Article = {
  id: string;
  sourceId: string;
  originalTitle: string;
  originalUrl: string;
  publishedAt: string | null;
  publishedDateJst: string | null;
  discoveredAt: string;
  processingStatus: string;
  lateArrival: boolean;
  createdAt: string;
};

type SourceDetail = Source & { recentArticles?: Article[] };

type SourceListResponse = {
  items: Source[];
  page: number;
  pageSize: number;
  total: number;
};

type SourceFormState = {
  name: string;
  websiteUrl: string;
  rssUrl: string;
  enabled: boolean;
};

const navigation: Array<{ key: NavKey; label: string }> = [
  { key: "/", label: "Dashboard" },
  { key: "/sources", label: "Sources" },
  { key: "/events", label: "Events" },
  { key: "/settings", label: "Settings" },
];

function getCurrentPath(): string {
  const path = window.location.pathname || "/";
  return path === "" ? "/" : path;
}

function isProtectedPath(path: string): boolean {
  if (path === "/login") {
    return false;
  }

  return path.startsWith("/api") === false;
}

function navigate(path: string): void {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function formatDate(value: string | null): string {
  if (!value) {
    return "Never";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "Never";
  }

  return parsed.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

/** Business timezone is fixed to Asia/Tokyo (JST). */
function formatJst(value: string | null): string {
  if (!value) return "Unknown time";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Unknown time";
  return `${parsed.toLocaleString("en-GB", { timeZone: "Asia/Tokyo", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })} JST`;
}

/** "YYYY-MM-DD" → "DD/MM/YYYY" without Date parsing (no browser-timezone shift). */
function formatLocalDate(localDate: string): string {
  const [year, month, day] = localDate.split("-");
  return `${day}/${month}/${year}`;
}

function humanizeDigestStatus(digest: Pick<DigestSummary, "status" | "isEmpty">): string {
  const labels: Record<DigestSummary["status"], string> = {
    scheduled: "Not generated",
    building: "Generating",
    ready: "Ready",
    sending: "Sending",
    sent: "Sent",
    failed: "Failed",
  };
  return `${labels[digest.status]}${digest.isEmpty ? " · Empty" : ""}`;
}

function humanizeDelivery(status: DigestSummary["deliveryStatus"]): string {
  if (!status) return "Not sent yet";
  const labels: Record<NonNullable<DigestSummary["deliveryStatus"]>, string> = {
    pending: "Pending",
    sending: "Sending",
    accepted: "Accepted by provider",
    delivered: "Delivered",
    failed: "Failed",
    unknown: "Unknown (reconciling)",
  };
  return labels[status];
}

function digestTone(status: DigestSummary["status"]): string {
  if (status === "sent") return "bg-emerald-100 text-emerald-700";
  if (status === "failed") return "bg-red-100 text-red-700";
  return "bg-slate-200 text-slate-700";
}

function humanizeEventProcessing(status: string): string | null {
  if (status === "processed") return null;
  if (status === "failed") return "Processing failed";
  return "Processing";
}

function humanizeStatus(status: SourceStatus | null | undefined): string {
  if (!status) return "Unknown";
  if (status === "active") return "Active";
  if (status === "disabled") return "Disabled";
  return "Error";
}

function getStatusClasses(status: SourceStatus | null | undefined): string {
  if (status === "active") {
    return "bg-emerald-100 text-emerald-700";
  }
  if (status === "disabled") {
    return "bg-slate-200 text-slate-700";
  }
  return "bg-red-100 text-red-700";
}

function App() {
  const [authState, setAuthState] = useState<AuthState>({ status: "loading" });
  const [currentPath, setCurrentPath] = useState<string>(getCurrentPath);
  const [loginState, setLoginState] = useState<LoginState>("idle");
  const [globalMessage, setGlobalMessage] = useState<string>("Your session has expired. Please sign in again.");
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [sourceQuery, setSourceQuery] = useState("");
  const [sourceStatusFilter, setSourceStatusFilter] = useState<"all" | SourceStatus>("all");
  const [sourcePage, setSourcePage] = useState(1);
  const [sourceList, setSourceList] = useState<Source[]>([]);
  const [sourceTotal, setSourceTotal] = useState(0);
  const [sourceListState, setSourceListState] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });
  const [sourceDetail, setSourceDetail] = useState<SourceDetail | null>(null);
  const [sourceDetailState, setSourceDetailState] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });
  const [sourceForm, setSourceForm] = useState<SourceFormState>({ name: "", websiteUrl: "", rssUrl: "", enabled: true });
  const [sourceFormState, setSourceFormState] = useState<{ saving: boolean; error: string | null }>({ saving: false, error: null });
  const [sourceNotice, setSourceNotice] = useState<string | null>(null);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [eventQuery, setEventQuery] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [eventSourceId, setEventSourceId] = useState("");
  const [eventPage, setEventPage] = useState(1);
  const [eventList, setEventList] = useState<EventListResponse | null>(null);
  const [eventListState, setEventListState] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });
  const [eventSourceOptions, setEventSourceOptions] = useState<Source[]>([]);
  const [eventDetail, setEventDetail] = useState<EventDetailResponse | null>(null);
  const [eventDetailState, setEventDetailState] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });

  const eventIdRoute = useMemo(() => currentPath.match(/^\/events\/([^/]+)$/)?.[1] ?? null, [currentPath]);

  const [dashboard, setDashboard] = useState<DashboardSummary | null>(null);
  const [recentEvents, setRecentEvents] = useState<EventListResponse["items"]>([]);
  const [recentDigests, setRecentDigests] = useState<DigestSummary[]>([]);
  const [dashboardState, setDashboardState] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });
  const [digestPreview, setDigestPreview] = useState<DigestPreviewResponse | null>(null);
  const [digestPreviewState, setDigestPreviewState] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });
  const [previewHeight, setPreviewHeight] = useState(900);
  const [settingsEmail, setSettingsEmail] = useState("");
  const [settingsState, setSettingsState] = useState<{ loading: boolean; saving: boolean; error: string | null; saved: boolean }>({
    loading: false,
    saving: false,
    error: null,
    saved: false,
  });
  const digestIdRoute = useMemo(() => currentPath.match(/^\/digests\/([^/]+)$/)?.[1] ?? null, [currentPath]);
  const previewFrameRef = useRef<HTMLIFrameElement>(null);

  // Size the sandboxed preview to its content. The load event can fire before React
  // attaches handlers for srcDoc iframes, so also check an already-complete document.
  useEffect(() => {
    const frame = previewFrameRef.current;
    if (!frame) return;
    const resize = (): void => {
      const height = frame.contentDocument?.body?.scrollHeight;
      if (height) setPreviewHeight(height + 24);
    };
    frame.addEventListener("load", resize);
    if (frame.contentDocument?.readyState === "complete") resize();
    return () => frame.removeEventListener("load", resize);
  }, [digestPreview]);

  const sourceIdRoute = useMemo(() => {
    const match = currentPath.match(/^\/sources\/([^/]+)$/);
    if (match) {
      return match[1];
    }

    const editMatch = currentPath.match(/^\/sources\/([^/]+)\/edit$/);
    if (editMatch) {
      return editMatch[1];
    }

    return null;
  }, [currentPath]);

  const activeRoute = useMemo(() => {
    if (currentPath === "/login") {
      return "/login";
    }
    if (currentPath.startsWith("/events/")) {
      return "/events";
    }
    return currentPath;
  }, [currentPath]);

  const pageTitle = useMemo(() => {
    if (currentPath === "/sources") return "Sources";
    if (currentPath === "/sources/new") return "Add Source";
    if (sourceIdRoute) {
      if (currentPath.endsWith("/edit")) return "Edit Source";
      return "Source Detail";
    }
    if (currentPath === "/events") return "News & Events";
    if (eventIdRoute) return "Event Detail";
    if (digestIdRoute) return "Daily Digest";
    if (currentPath === "/settings") return "Settings";
    return "Dashboard";
  }, [currentPath, digestIdRoute, eventIdRoute, sourceIdRoute]);

  const fetchCsrfToken = useCallback(async (): Promise<string> => {
    const response = await fetch("/api/v1/auth/csrf", { credentials: "include" });
    if (!response.ok) {
      throw new Error("Unable to obtain CSRF token.");
    }

    const payload = (await response.json()) as { token: string };
    setCsrfToken(payload.token);
    return payload.token;
  }, []);

  const apiFetch = useCallback(
    async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
      const response = await fetch(path, { credentials: "include", ...init });

      if (response.status === 401) {
        setAuthState({ status: "unauthenticated" });
        navigate("/login");
        throw new Error("Your session has expired. Please sign in again.");
      }

      if (!response.ok) {
        const maybePayload = (await response.json().catch(() => null)) as { error?: { message?: string } | string } | null;
        const message =
          typeof maybePayload?.error === "string"
            ? maybePayload.error
            : maybePayload?.error?.message ?? "Request failed.";
        throw new Error(message);
      }

      const text = await response.text();
      if (!text) {
        return undefined as T;
      }
      return JSON.parse(text) as T;
    },
    [],
  );

  const refreshSession = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch("/api/v1/auth/session", { credentials: "include" });

      if (response.ok) {
        const payload = (await response.json()) as { user: { id: string; email: string } };
        setAuthState({ status: "authenticated", user: payload.user });
        return;
      }

      setAuthState({ status: "unauthenticated" });
    } catch {
      setAuthState({ status: "unauthenticated" });
    }
  }, []);

  const handleLogout = useCallback(async (): Promise<void> => {
    setLogoutError(null);
    try {
      const token = await fetchCsrfToken();
      const response = await fetch("/api/v1/auth/logout", {
        method: "POST",
        credentials: "include",
        headers: {
          "X-CSRF-Token": token,
        },
      });
      if (!response.ok) {
        throw new Error("Could not log out. Please try again.");
      }

      setAuthState({ status: "unauthenticated" });
      setGlobalMessage("Your session has expired. Please sign in again.");
      navigate("/login");
    } catch {
      setLogoutError("Could not log out. Please try again.");
    }
  }, [fetchCsrfToken]);

  const loadSources = useCallback(async (): Promise<void> => {
    if (authState.status !== "authenticated") {
      return;
    }

    setSourceListState({ loading: true, error: null });
    try {
      const params = new URLSearchParams({ page: String(sourcePage), pageSize: "20" });
      if (sourceQuery.trim()) {
        params.set("search", sourceQuery.trim());
      }
      if (sourceStatusFilter !== "all") {
        params.set("status", sourceStatusFilter);
      }

      const payload = await apiFetch<SourceListResponse>(`/api/v1/sources?${params.toString()}`);
      setSourceList(payload.items);
      setSourceTotal(payload.total);
      setSourcePage(payload.page);
      setSourceListState({ loading: false, error: null });
    } catch (error) {
      setSourceListState({ loading: false, error: error instanceof Error ? error.message : "Could not load sources." });
    }
  }, [apiFetch, authState.status, sourcePage, sourceQuery, sourceStatusFilter]);

  const loadSourceDetail = useCallback(
    async (sourceId: string): Promise<void> => {
      setSourceDetailState({ loading: true, error: null });
      try {
        const detail = await apiFetch<SourceDetail>(`/api/v1/sources/${sourceId}`);
        setSourceDetail(detail);
        setSourceForm({
          name: detail.name,
          websiteUrl: detail.websiteUrl,
          rssUrl: detail.rssUrl ?? "",
          enabled: detail.enabled,
        });
        setSourceDetailState({ loading: false, error: null });
      } catch (error) {
        setSourceDetailState({ loading: false, error: error instanceof Error ? error.message : "Could not load source." });
      }
    },
    [apiFetch],
  );

  const loadDashboard = useCallback(async (): Promise<void> => {
    setDashboardState({ loading: true, error: null });
    try {
      const [summary, events, digests] = await Promise.all([
        apiFetch<DashboardSummary>("/api/v1/dashboard/summary"),
        apiFetch<EventListResponse>("/api/v1/events?page=1&pageSize=3&sort=latest"),
        apiFetch<DigestListResponse>("/api/v1/digests?page=1&pageSize=5"),
      ]);
      setDashboard(summary);
      setRecentEvents(events.items);
      setRecentDigests(digests.items);
      setDashboardState({ loading: false, error: null });
    } catch (error) {
      setDashboardState({ loading: false, error: error instanceof Error ? error.message : "Could not load the dashboard." });
    }
  }, [apiFetch]);

  const loadDigestPreview = useCallback(
    async (digestId: string): Promise<void> => {
      setDigestPreviewState({ loading: true, error: null });
      try {
        setDigestPreview(await apiFetch<DigestPreviewResponse>(`/api/v1/digests/${digestId}/preview`));
        setDigestPreviewState({ loading: false, error: null });
      } catch (error) {
        setDigestPreview(null);
        setDigestPreviewState({ loading: false, error: error instanceof Error ? error.message : "Could not load the digest." });
      }
    },
    [apiFetch],
  );

  const loadSettings = useCallback(async (): Promise<void> => {
    setSettingsState((current) => ({ ...current, loading: true, error: null }));
    try {
      const [settings, digests] = await Promise.all([
        apiFetch<SettingsResponse>("/api/v1/settings"),
        apiFetch<DigestListResponse>("/api/v1/digests?page=1&pageSize=1"),
      ]);
      setSettingsEmail(settings.recipientEmail);
      setRecentDigests(digests.items);
      setSettingsState((current) => ({ ...current, loading: false, error: null }));
    } catch (error) {
      setSettingsState((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : "Could not load settings." }));
    }
  }, [apiFetch]);

  const handleSaveSettings = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const recipientEmail = settingsEmail.trim();
    if (!recipientEmail) {
      setSettingsState((current) => ({ ...current, error: "Recipient email is required.", saved: false }));
      return;
    }
    setSettingsState((current) => ({ ...current, saving: true, error: null, saved: false }));
    try {
      const token = await fetchCsrfToken();
      const saved = await apiFetch<SettingsResponse>("/api/v1/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
        body: JSON.stringify({ recipientEmail }),
      });
      setSettingsEmail(saved.recipientEmail);
      setSettingsState((current) => ({ ...current, saving: false, error: null, saved: true }));
    } catch (error) {
      setSettingsState((current) => ({ ...current, saving: false, error: error instanceof Error ? error.message : "Could not save settings.", saved: false }));
    }
  };

  const loadEvents = useCallback(async (): Promise<void> => {
    if (authState.status !== "authenticated") {
      return;
    }

    setEventListState({ loading: true, error: null });
    try {
      const params = new URLSearchParams({ page: String(eventPage), pageSize: "20", sort: "latest" });
      if (eventQuery.trim()) params.set("search", eventQuery.trim());
      if (eventDate) params.set("date", eventDate);
      if (eventSourceId) params.set("sourceId", eventSourceId);
      const payload = await apiFetch<EventListResponse>(`/api/v1/events?${params.toString()}`);
      setEventList(payload);
      setEventListState({ loading: false, error: null });
    } catch (error) {
      setEventListState({ loading: false, error: error instanceof Error ? error.message : "Could not load events." });
    }
  }, [apiFetch, authState.status, eventDate, eventPage, eventQuery, eventSourceId]);

  const loadEventSourceOptions = useCallback(async (): Promise<void> => {
    try {
      const payload = await apiFetch<SourceListResponse>("/api/v1/sources?page=1&pageSize=100");
      setEventSourceOptions(payload.items);
    } catch {
      setEventSourceOptions([]);
    }
  }, [apiFetch]);

  const loadEventDetail = useCallback(
    async (eventId: string): Promise<void> => {
      setEventDetailState({ loading: true, error: null });
      try {
        setEventDetail(await apiFetch<EventDetailResponse>(`/api/v1/events/${eventId}`));
        setEventDetailState({ loading: false, error: null });
      } catch (error) {
        setEventDetail(null);
        setEventDetailState({ loading: false, error: error instanceof Error ? error.message : "Could not load event." });
      }
    },
    [apiFetch],
  );

  useEffect(() => {
    const syncPath = (): void => setCurrentPath(getCurrentPath());
    window.addEventListener("popstate", syncPath);
    syncPath();
    return () => window.removeEventListener("popstate", syncPath);
  }, []);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  useEffect(() => {
    if (authState.status === "loading") {
      return;
    }

    if (authState.status === "authenticated" && currentPath === "/login") {
      navigate("/");
      return;
    }

    if (authState.status === "unauthenticated" && isProtectedPath(currentPath)) {
      navigate("/login");
    }
  }, [authState, currentPath]);

  useEffect(() => {
    if (authState.status === "authenticated" && currentPath === "/sources") {
      void loadSources();
    }
  }, [authState.status, currentPath, loadSources]);

  useEffect(() => {
    if (authState.status !== "authenticated" || !sourceIdRoute || currentPath === "/sources/new") {
      return;
    }

    void loadSourceDetail(sourceIdRoute);
  }, [authState.status, currentPath, loadSourceDetail, sourceIdRoute]);

  useEffect(() => {
    if (authState.status === "authenticated" && currentPath === "/events") {
      void loadEvents();
    }
  }, [authState.status, currentPath, loadEvents]);

  useEffect(() => {
    if (authState.status === "authenticated" && currentPath === "/events") {
      void loadEventSourceOptions();
    }
  }, [authState.status, currentPath, loadEventSourceOptions]);

  useEffect(() => {
    if (authState.status === "authenticated" && eventIdRoute) {
      void loadEventDetail(eventIdRoute);
    }
  }, [authState.status, eventIdRoute, loadEventDetail]);

  useEffect(() => {
    if (authState.status === "authenticated" && currentPath === "/") {
      void loadDashboard();
    }
  }, [authState.status, currentPath, loadDashboard]);

  useEffect(() => {
    if (authState.status === "authenticated" && digestIdRoute) {
      void loadDigestPreview(digestIdRoute);
    }
  }, [authState.status, digestIdRoute, loadDigestPreview]);

  useEffect(() => {
    if (authState.status === "authenticated" && currentPath === "/settings") {
      setSettingsState((current) => ({ ...current, saved: false }));
      void loadSettings();
    }
  }, [authState.status, currentPath, loadSettings]);

  const handleLogin = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const email = String(formData.get("email") ?? "");
    const password = String(formData.get("password") ?? "");

    setLoginState("loading");
    try {
      const token = await fetchCsrfToken();
      const response = await fetch("/api/v1/auth/login", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": token,
        },
        body: JSON.stringify({ email, password }),
      });

      if (response.status === 429) {
        setLoginState("rate-limited");
        setGlobalMessage("Too many login attempts. Please try again later.");
        return;
      }

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({ error: "Invalid email or password." }))) as { error?: string };
        setLoginState("error");
        setGlobalMessage(payload.error ?? "Invalid email or password.");
        return;
      }

      const payload = (await response.json()) as { user: { id: string; email: string } };
      setAuthState({ status: "authenticated", user: payload.user });
      setLoginState("success");
      setGlobalMessage("Your session has expired. Please sign in again.");
      navigate("/");
    } catch {
      setLoginState("server-error");
      setGlobalMessage("Unable to sign in right now. Please try again.");
    }
  };

  const handleSaveSource = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!sourceForm.name.trim()) {
      setSourceFormState({ saving: false, error: "Source name is required." });
      return;
    }

    const payload = {
      name: sourceForm.name.trim(),
      websiteUrl: sourceForm.websiteUrl.trim(),
      rssUrl: sourceForm.rssUrl.trim() || null,
      enabled: sourceForm.enabled,
    };

    setSourceFormState({ saving: true, error: null });

    try {
      // Always fetch a fresh token: login clears the CSRF cookie, so a cached one is stale.
      const token = await fetchCsrfToken();
      const isEditing = currentPath.endsWith("/edit");
      const endpoint = isEditing ? `/api/v1/sources/${sourceIdRoute}` : "/api/v1/sources";
      const method = isEditing ? "PATCH" : "POST";

      await apiFetch(endpoint, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": token,
        },
        body: JSON.stringify(payload),
      });

      setSourceFormState({ saving: false, error: null });
      setSourceNotice(isEditing ? "Source saved." : "Source created.");
      navigate("/sources");
      void loadSources();
    } catch (error) {
      setSourceFormState({ saving: false, error: error instanceof Error ? error.message : "Could not save source." });
    }
  };

  const handleDeleteSource = async (source: Source): Promise<void> => {
    const confirmed = window.confirm(`Delete ${source.name}? This action cannot be undone.`);
    if (!confirmed) {
      return;
    }

    try {
      // Always fetch a fresh token: login clears the CSRF cookie, so a cached one is stale.
      const token = await fetchCsrfToken();
      await apiFetch(`/api/v1/sources/${source.id}`, {
        method: "DELETE",
        headers: { "X-CSRF-Token": token },
      });
      setSourceNotice(`Deleted source ${source.name}.`);
      setSourceList((current) => current.filter((item) => item.id !== source.id));
      if (sourceIdRoute === source.id) {
        navigate("/sources");
      }
      void loadSources();
    } catch (error) {
      setSourceNotice(error instanceof Error ? error.message : "Could not delete source.");
    }
  };

  const handleRetrySource = async (source: Source): Promise<void> => {
    try {
      // Always fetch a fresh token: login clears the CSRF cookie, so a cached one is stale.
      const token = await fetchCsrfToken();
      const result = await apiFetch<{ jobId: string; status: "queued" }>(`/api/v1/sources/${source.id}/retry`, {
        method: "POST",
        headers: { "X-CSRF-Token": token },
      });
      if (result.status === "queued") {
        setSourceNotice("Collection queued.");
      }
    } catch (error) {
      setSourceNotice(error instanceof Error ? error.message : "Could not queue collection.");
    }
  };

  const handleToggleSource = async (source: Source): Promise<void> => {
    try {
      // Always fetch a fresh token: login clears the CSRF cookie, so a cached one is stale.
      const token = await fetchCsrfToken();
      const updated = await apiFetch<Source>(`/api/v1/sources/${source.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": token,
        },
        body: JSON.stringify({ enabled: !source.enabled }),
      });
      setSourceList((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setSourceDetail((current) => (current && current.id === updated.id ? { ...current, ...updated } : current));
      setSourceNotice(`${updated.name} ${updated.enabled ? "enabled" : "disabled"}.`);
      void loadSources();
    } catch (error) {
      setSourceNotice(error instanceof Error ? error.message : "Could not update source.");
    }
  };

  if (authState.status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100 text-sm text-slate-600">
        Loading session...
      </div>
    );
  }

  if (authState.status === "unauthenticated" || currentPath === "/login") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f8f9fb] p-6 text-slate-800">
        <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="mb-8 text-center">
            <div className="mb-4 flex items-center justify-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#3157d5] text-lg font-bold text-white">
                N
              </div>
              <div className="text-left">
                <div className="text-xl font-semibold tracking-tight">News Digest</div>
              </div>
            </div>
            <p className="text-sm text-slate-500">Read less. Know more.</p>
          </div>

          <form className="space-y-5" onSubmit={handleLogin}>
            <div>
              <label htmlFor="email" className="mb-2 block text-sm font-medium text-slate-700">
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none transition focus:border-[#3157d5] focus:bg-white focus:ring-2 focus:ring-[#3157d5]/15"
                placeholder="admin@example.com"
                required
              />
            </div>

            <div>
              <label htmlFor="password" className="mb-2 block text-sm font-medium text-slate-700">
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none transition focus:border-[#3157d5] focus:bg-white focus:ring-2 focus:ring-[#3157d5]/15"
                placeholder="••••••••"
                required
              />
            </div>

            {loginState !== "idle" && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                {loginState === "rate-limited" && "Too many login attempts. Please try again later."}
                {loginState === "server-error" && "Unable to sign in right now. Please try again."}
                {loginState === "error" && globalMessage}
                {loginState === "success" && "Signed in successfully."}
              </div>
            )}

            <button
              type="submit"
              className="w-full rounded-xl bg-[#3157d5] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#2648be] disabled:cursor-not-allowed disabled:opacity-70"
              disabled={loginState === "loading"}
            >
              {loginState === "loading" ? "Signing in..." : "Sign in"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  const latestDigest = dashboard?.latestDigest ?? null;
  const summaryCards = [
    { label: "Active Sources", value: dashboard ? String(dashboard.activeSources) : "—" },
    { label: "Articles Collected", value: dashboard ? String(dashboard.articlesCollected) : "—" },
    { label: "Events Detected", value: dashboard ? String(dashboard.eventsDetected) : "—" },
    { label: "Latest Digest", value: latestDigest ? formatLocalDate(latestDigest.localDate) : "None yet" },
  ];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-top">
          <div className="logo">
            <span className="logo-mark">
              <i />
              <i />
            </span>
            News Digest
          </div>
          <div className="sidebar-tagline">Read less. Know more.</div>
        </div>

        <nav>
          {navigation.map((item) => (
            <button
              key={item.key}
              type="button"
              className={activeRoute === item.key ? "active" : ""}
              onClick={() => navigate(item.key)}
            >
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="sync-card">
            <span>✓</span>
            <div>
              <strong>Last sync</strong>
              <small>just now</small>
            </div>
          </div>

          <button type="button" className="profile" onClick={() => navigate("/settings")}>
            <span>{authState.status === "authenticated" ? authState.user.email.slice(0, 2).toUpperCase() : "AD"}</span>
            <div>
              <strong>{authState.status === "authenticated" ? authState.user.email : "Admin"}</strong>
              <small>Operator</small>
            </div>
          </button>
        </div>
      </aside>

      <main className="main-content">
        <div className="page-header">
          <div>
            <h1>{pageTitle}</h1>
            <p className="mt-2 text-sm text-slate-500">Daily monitoring and digest overview</p>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-300"
          >
            Logout
          </button>
        </div>
        {logoutError && (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
            {logoutError}
          </div>
        )}

        {currentPath === "/" && (
          <div className="mt-8 space-y-8">
            <section className="grid gap-4 md:grid-cols-4">
              {summaryCards.map((card) => (
                <article key={card.label} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <p className="text-sm text-slate-500">{card.label}</p>
                  <div className="mt-3 text-3xl font-semibold tracking-tight text-slate-900">{card.value}</div>
                </article>
              ))}
            </section>

            {dashboardState.error && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
                {dashboardState.error}
              </div>
            )}

            <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm" aria-label="Daily Digest">
              <div className="mb-4 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-slate-900">Daily Digest</h2>
                  {dashboard && (
                    <p className="text-sm text-slate-500" data-testid="next-digest">
                      Next digest: {formatJst(dashboard.nextDigest.sendAt)} · news from {formatLocalDate(dashboard.nextDigest.localDate)}
                    </p>
                  )}
                </div>
                {latestDigest && (
                  <button type="button" className="text-sm font-medium text-[#3157d5]" onClick={() => navigate(`/digests/${latestDigest.id}`)}>
                    View latest digest
                  </button>
                )}
              </div>
              {dashboardState.loading && !dashboard ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-6 text-sm text-slate-600">Loading digests...</div>
              ) : recentDigests.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-600">
                  No digest has been generated yet. The first one is built at 06:00 JST and sent at 07:00 JST.
                </div>
              ) : (
                <div className="space-y-3">
                  {recentDigests.map((digest) => (
                    <button
                      key={digest.id}
                      type="button"
                      className="flex w-full items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-3 text-left text-sm text-slate-700"
                      onClick={() => navigate(`/digests/${digest.id}`)}
                    >
                      <span>
                        <strong className="text-slate-900">{digest.subject}</strong>
                        <span className="text-slate-500"> · {formatLocalDate(digest.localDate)} · {digest.eventCount} events · {humanizeDelivery(digest.deliveryStatus)}</span>
                      </span>
                      <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${digestTone(digest.status)}`}>{humanizeDigestStatus(digest)}</span>
                    </button>
                  ))}
                </div>
              )}
            </section>

            <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-lg font-semibold text-slate-900">Recent events</h2>
                <button type="button" className="text-sm font-medium text-[#3157d5]" onClick={() => navigate("/events")}>
                  View all
                </button>
              </div>
              {dashboardState.loading && recentEvents.length === 0 ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-6 text-sm text-slate-600">Loading events...</div>
              ) : recentEvents.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-600">No events yet.</div>
              ) : (
                <div className="space-y-3">
                  {recentEvents.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className="flex w-full items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-3 text-left text-sm text-slate-700"
                      onClick={() => navigate(`/events/${item.id}`)}
                    >
                      <span>{item.titleVi}</span>
                      <span className="shrink-0 text-xs text-slate-500">{formatJst(item.latestArticleAt)}</span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}

        {digestIdRoute && (
          <div className="mt-8">
            <button type="button" className="back-link" onClick={() => navigate("/")}>
              <span>←</span> Back to dashboard
            </button>
            {digestPreviewState.loading ? (
              <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-6 text-sm text-slate-600">Loading digest...</div>
            ) : digestPreviewState.error ? (
              <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
                {digestPreviewState.error}
              </div>
            ) : digestPreview ? (
              <>
                <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <h2 className="text-lg font-semibold text-slate-900">{digestPreview.subject}</h2>
                  <p className="mt-1 text-sm text-slate-500">
                    News date {digestPreview.displayDate} (JST) · {digestPreview.eventCount} events
                    {digestPreview.isEmpty ? " · Empty digest" : ""}
                  </p>
                  <p className="mt-2 text-xs text-slate-500">Preview only — opening this page never sends an email.</p>
                </div>
                <div className="email-canvas mt-4 rounded-2xl">
                  <iframe
                    ref={previewFrameRef}
                    title="Daily digest email preview"
                    srcDoc={digestPreview.html}
                    sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                    className="w-full rounded-xl border-0 bg-white"
                    style={{ height: previewHeight }}
                  />
                </div>
              </>
            ) : null}
          </div>
        )}

        {currentPath === "/sources" && (
          <div className="mt-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-slate-900">Managed sources</h2>
              <button type="button" className="rounded-xl bg-[#3157d5] px-3 py-2 text-sm font-medium text-white" onClick={() => navigate("/sources/new")}>
                Add source
              </button>
            </div>

            <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <input
                value={sourceQuery}
                onChange={(event) => {
                  setSourceQuery(event.target.value);
                  setSourcePage(1);
                }}
                placeholder="Search source or website"
                className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none transition focus:border-[#3157d5] focus:bg-white focus:ring-2 focus:ring-[#3157d5]/15 md:max-w-xs"
              />

              <select
                value={sourceStatusFilter}
                onChange={(event) => {
                  setSourceStatusFilter(event.target.value as "all" | SourceStatus);
                  setSourcePage(1);
                }}
                className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 outline-none transition focus:border-[#3157d5] focus:bg-white focus:ring-2 focus:ring-[#3157d5]/15"
              >
                <option value="all">All statuses</option>
                <option value="active">Active</option>
                <option value="disabled">Disabled</option>
                <option value="error">Error</option>
              </select>
            </div>

            {sourceNotice && (
              <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                {sourceNotice}
              </div>
            )}

            {sourceListState.error && (
              <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {sourceListState.error}
              </div>
            )}

            {sourceListState.loading ? (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-6 text-sm text-slate-600">Loading sources...</div>
            ) : sourceList.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-8 text-center text-sm text-slate-600">
                No sources found. Add your first source to begin monitoring.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <div className="table-card min-w-[720px]">
                  <div className="source-table source-head">
                    <div>Name</div>
                    <div>Status</div>
                    <div>Last sync</div>
                    <div>Enabled</div>
                    <div className="text-right">Actions</div>
                  </div>

                  {sourceList.map((source) => (
                    <div key={source.id} className="source-table source-row">
                      <div className="source-name">
                        <span className="source-avatar">{source.name.slice(0, 2).toUpperCase()}</span>
                        <div>
                          <strong>{source.name}</strong>
                          <small>{source.websiteUrl}</small>
                        </div>
                      </div>
                      <div>
                        <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${getStatusClasses(source.status)}`}>
                          {humanizeStatus(source.status)}
                        </span>
                      </div>
                      <div className="cell-muted">{formatDate(source.lastFetchedAt)}</div>
                      <div className="cell-muted">{source.enabled ? "Enabled" : "Disabled"}</div>
                      <div className="row-actions">
                        <button type="button" title="View details" onClick={() => navigate(`/sources/${source.id}`)}>
                          ↗
                        </button>
                        <button type="button" title="Edit" onClick={() => navigate(`/sources/${source.id}/edit`)}>
                          ✎
                        </button>
                        <button type="button" title={source.enabled ? "Disable" : "Enable"} onClick={() => void handleToggleSource(source)}>
                          {source.enabled ? "Off" : "On"}
                        </button>
                        <button type="button" title="Retry collection" onClick={() => void handleRetrySource(source)}>
                          ⟳
                        </button>
                        <button type="button" title="Delete" onClick={() => void handleDeleteSource(source)}>
                          🗑
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-4 flex items-center justify-between text-sm text-slate-500">
              <span>
                Showing {sourceList.length} of {sourceTotal || sourceList.length}
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-sm disabled:opacity-50"
                  disabled={sourcePage <= 1}
                  onClick={() => setSourcePage((page) => Math.max(1, page - 1))}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-sm disabled:opacity-50"
                  disabled={sourceList.length < 20 && sourcePage * 20 >= sourceTotal}
                  onClick={() => setSourcePage((page) => page + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          </div>
        )}

        {currentPath === "/sources/new" && (
          <div className="mt-8 max-w-3xl rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <button type="button" className="mb-4 text-sm font-medium text-slate-600" onClick={() => navigate("/sources")}>
              ← Back to sources
            </button>
            <div className="rounded-2xl border border-slate-200 bg-white p-5">
              <div className="mb-6 flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#3157d5]/10 text-[#3157d5]">+</div>
                <div>
                  <h2 className="text-lg font-semibold text-slate-900">Add source</h2>
                  <p className="text-sm text-slate-500">Create a new monitored RSS source.</p>
                </div>
              </div>

              <form onSubmit={handleSaveSource} className="space-y-4">
                {sourceFormState.error && (
                  <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{sourceFormState.error}</div>
                )}

                <div>
                  <label className="mb-2 block text-sm font-medium text-slate-700">Source name</label>
                  <input
                    value={sourceForm.name}
                    onChange={(event) => setSourceForm((current) => ({ ...current, name: event.target.value }))}
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none transition focus:border-[#3157d5] focus:bg-white focus:ring-2 focus:ring-[#3157d5]/15"
                    placeholder="VnExpress"
                    required
                  />
                </div>

                <div>
                  <label className="mb-2 block text-sm font-medium text-slate-700">Website URL</label>
                  <input
                    type="url"
                    value={sourceForm.websiteUrl}
                    onChange={(event) => setSourceForm((current) => ({ ...current, websiteUrl: event.target.value }))}
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none transition focus:border-[#3157d5] focus:bg-white focus:ring-2 focus:ring-[#3157d5]/15"
                    placeholder="https://example.com"
                    required
                  />
                </div>

                <div>
                  <label className="mb-2 block text-sm font-medium text-slate-700">RSS URL</label>
                  <input
                    type="url"
                    value={sourceForm.rssUrl}
                    onChange={(event) => setSourceForm((current) => ({ ...current, rssUrl: event.target.value }))}
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none transition focus:border-[#3157d5] focus:bg-white focus:ring-2 focus:ring-[#3157d5]/15"
                    placeholder="https://example.com/rss.xml"
                  />
                </div>

                <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <div>
                    <div className="text-sm font-medium text-slate-800">Enable source</div>
                    <div className="text-xs text-slate-500">Allow collection jobs to run for this source.</div>
                  </div>
                  <button
                    type="button"
                    className={`relative h-7 w-12 rounded-full transition ${sourceForm.enabled ? "bg-[#3157d5]" : "bg-slate-300"}`}
                    onClick={() => setSourceForm((current) => ({ ...current, enabled: !current.enabled }))}
                  >
                    <span className={`absolute top-1 h-5 w-5 rounded-full bg-white transition ${sourceForm.enabled ? "left-6" : "left-1"}`} />
                  </button>
                </div>

                <div className="flex justify-end gap-3 pt-2">
                  <button type="button" className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700" onClick={() => navigate("/sources")}>
                    Cancel
                  </button>
                  <button type="submit" className="rounded-xl bg-[#3157d5] px-4 py-2 text-sm font-semibold text-white disabled:opacity-70" disabled={sourceFormState.saving}>
                    {sourceFormState.saving ? "Saving..." : "Save source"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {sourceIdRoute && currentPath !== "/sources" && currentPath !== "/sources/new" && !currentPath.endsWith("/edit") && (
          <div className="mt-8 max-w-5xl rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <button type="button" className="mb-4 text-sm font-medium text-slate-600" onClick={() => navigate("/sources")}>
              ← Back to sources
            </button>

            {sourceDetailState.loading ? (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-6 text-sm text-slate-600">Loading source details...</div>
            ) : sourceDetailState.error ? (
              <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{sourceDetailState.error}</div>
            ) : sourceDetail ? (
              <>
                <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                  <div className="flex items-center gap-4">
                    <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[#3157d5]/10 text-lg font-semibold text-[#3157d5]">
                      {sourceDetail.name.slice(0, 2).toUpperCase()}
                    </div>
                    <div>
                      <div className="flex items-center gap-3">
                        <h2 className="text-2xl font-semibold text-slate-900">{sourceDetail.name}</h2>
                        <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${getStatusClasses(sourceDetail.status)}`}>
                          {humanizeStatus(sourceDetail.status)}
                        </span>
                      </div>
                      <p className="text-sm text-slate-500">{sourceDetail.websiteUrl}</p>
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <button type="button" className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700" onClick={() => navigate(`/sources/${sourceDetail.id}/edit`)}>
                      Edit
                    </button>
                    <button type="button" className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700" onClick={() => void handleToggleSource(sourceDetail)}>
                      {sourceDetail.enabled ? "Disable" : "Enable"}
                    </button>
                    <button type="button" className="rounded-xl bg-[#3157d5] px-3 py-2 text-sm font-semibold text-white" onClick={() => void handleRetrySource(sourceDetail)}>
                      Retry
                    </button>
                  </div>
                </div>

                <div className="mt-6 grid gap-4 lg:grid-cols-[1.5fr_0.9fr]">
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
                    <h3 className="mb-4 text-lg font-semibold text-slate-900">Source details</h3>
                    <dl className="space-y-4 text-sm">
                      <div className="flex justify-between gap-3 border-b border-slate-200 pb-3">
                        <dt className="text-slate-500">Website</dt>
                        <dd className="text-right text-slate-800"><a href={sourceDetail.websiteUrl} className="text-[#3157d5]" target="_blank" rel="noreferrer">{sourceDetail.websiteUrl}</a></dd>
                      </div>
                      <div className="flex justify-between gap-3 border-b border-slate-200 pb-3">
                        <dt className="text-slate-500">RSS URL</dt>
                        <dd className="text-right text-slate-800">{sourceDetail.rssUrl ?? "Not configured"}</dd>
                      </div>
                      <div className="flex justify-between gap-3 border-b border-slate-200 pb-3">
                        <dt className="text-slate-500">Enabled</dt>
                        <dd className="text-slate-800">{sourceDetail.enabled ? "Enabled" : "Disabled"}</dd>
                      </div>
                      <div className="flex justify-between gap-3 border-b border-slate-200 pb-3">
                        <dt className="text-slate-500">Status</dt>
                        <dd className="text-slate-800">{humanizeStatus(sourceDetail.status)}</dd>
                      </div>
                      <div className="flex justify-between gap-3 border-b border-slate-200 pb-3">
                        <dt className="text-slate-500">Last successful collection</dt>
                        <dd className="text-right text-slate-800">{formatDate(sourceDetail.lastFetchedAt)}</dd>
                      </div>
                      <div className="flex justify-between gap-3 pb-1">
                        <dt className="text-slate-500">Last error</dt>
                        <dd className="text-right text-slate-800">{sourceDetail.lastErrorCode ?? "None"}</dd>
                      </div>
                      <div className="flex justify-between gap-3 pb-1">
                        <dt className="text-slate-500">Last error time</dt>
                        <dd className="text-right text-slate-800">{formatDate(sourceDetail.lastErrorAt)}</dd>
                      </div>
                    </dl>
                  </div>

                  <div className="rounded-2xl border border-slate-200 bg-white p-5">
                    <h3 className="mb-4 text-lg font-semibold text-slate-900">Collection</h3>
                    <div className="rounded-xl bg-slate-50 p-4">
                      <div className="text-sm text-slate-500">Status</div>
                      <div className="mt-2 text-3xl font-semibold text-slate-900">{humanizeStatus(sourceDetail.status)}</div>
                    </div>
                    <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                      <div className="rounded-xl border border-slate-200 p-3">
                        <div className="text-slate-500">Enabled</div>
                        <div className="mt-2 font-medium text-slate-800">{sourceDetail.enabled ? "Yes" : "No"}</div>
                      </div>
                      <div className="rounded-xl border border-slate-200 p-3">
                        <div className="text-slate-500">Last sync</div>
                        <div className="mt-2 font-medium text-slate-800">{formatDate(sourceDetail.lastFetchedAt)}</div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-5">
                  <h3 className="mb-4 text-lg font-semibold text-slate-900">Recent articles</h3>
                  {!sourceDetail.recentArticles || sourceDetail.recentArticles.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-6 text-sm text-slate-600">
                      No recent articles available for this source yet.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {sourceDetail.recentArticles.map((article) => (
                        <div key={article.id} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <h4 className="text-sm font-semibold text-slate-900">{article.originalTitle}</h4>
                              <div className="mt-1 text-xs text-slate-500">
                                {article.publishedDateJst ?? formatDate(article.publishedAt)}
                              </div>
                            </div>
                            <a href={article.originalUrl} className="text-xs font-medium text-[#3157d5]" target="_blank" rel="noreferrer">
                              Open
                            </a>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            ) : null}
          </div>
        )}

        {sourceIdRoute && currentPath !== "/sources" && currentPath !== "/sources/new" && currentPath.endsWith("/edit") && sourceDetail && (
          <div className="mt-8 max-w-3xl rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <button type="button" className="mb-4 text-sm font-medium text-slate-600" onClick={() => navigate(`/sources/${sourceIdRoute}`)}>
              ← Back to source
            </button>
            <div className="rounded-2xl border border-slate-200 bg-white p-5">
              <div className="mb-6 flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#3157d5]/10 text-[#3157d5]">✎</div>
                <div>
                  <h2 className="text-lg font-semibold text-slate-900">Edit source</h2>
                  <p className="text-sm text-slate-500">Update this source configuration.</p>
                </div>
              </div>

              <form onSubmit={handleSaveSource} className="space-y-4">
                {sourceFormState.error && (
                  <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{sourceFormState.error}</div>
                )}

                <div>
                  <label className="mb-2 block text-sm font-medium text-slate-700">Source name</label>
                  <input
                    value={sourceForm.name}
                    onChange={(event) => setSourceForm((current) => ({ ...current, name: event.target.value }))}
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none transition focus:border-[#3157d5] focus:bg-white focus:ring-2 focus:ring-[#3157d5]/15"
                    required
                  />
                </div>

                <div>
                  <label className="mb-2 block text-sm font-medium text-slate-700">Website URL</label>
                  <input
                    type="url"
                    value={sourceForm.websiteUrl}
                    onChange={(event) => setSourceForm((current) => ({ ...current, websiteUrl: event.target.value }))}
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none transition focus:border-[#3157d5] focus:bg-white focus:ring-2 focus:ring-[#3157d5]/15"
                    required
                  />
                </div>

                <div>
                  <label className="mb-2 block text-sm font-medium text-slate-700">RSS URL</label>
                  <input
                    type="url"
                    value={sourceForm.rssUrl}
                    onChange={(event) => setSourceForm((current) => ({ ...current, rssUrl: event.target.value }))}
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none transition focus:border-[#3157d5] focus:bg-white focus:ring-2 focus:ring-[#3157d5]/15"
                  />
                </div>

                <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <div>
                    <div className="text-sm font-medium text-slate-800">Enable source</div>
                    <div className="text-xs text-slate-500">Allow collection jobs to run for this source.</div>
                  </div>
                  <button
                    type="button"
                    className={`relative h-7 w-12 rounded-full transition ${sourceForm.enabled ? "bg-[#3157d5]" : "bg-slate-300"}`}
                    onClick={() => setSourceForm((current) => ({ ...current, enabled: !current.enabled }))}
                  >
                    <span className={`absolute top-1 h-5 w-5 rounded-full bg-white transition ${sourceForm.enabled ? "left-6" : "left-1"}`} />
                  </button>
                </div>

                <div className="flex justify-end gap-3 pt-2">
                  <button type="button" className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700" onClick={() => navigate(`/sources/${sourceIdRoute}`)}>
                    Cancel
                  </button>
                  <button type="submit" className="rounded-xl bg-[#3157d5] px-4 py-2 text-sm font-semibold text-white disabled:opacity-70" disabled={sourceFormState.saving}>
                    {sourceFormState.saving ? "Saving..." : "Save changes"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {currentPath === "/events" && (
          <div>
            <div className="filter-bar">
              <label className="search-box filter-search">
                <span aria-hidden="true">⌕</span>
                <input
                  value={eventQuery}
                  onChange={(event) => {
                    setEventQuery(event.target.value);
                    setEventPage(1);
                  }}
                  placeholder="Search events, articles, or sources..."
                  aria-label="Search events"
                />
              </label>
              <label className="filter-button filter-select-label">
                <input
                  type="date"
                  value={eventDate}
                  onChange={(event) => {
                    setEventDate(event.target.value);
                    setEventPage(1);
                  }}
                  aria-label="Filter by date (JST)"
                />
              </label>
              <label className="filter-button filter-select-label">
                <select
                  value={eventSourceId}
                  onChange={(event) => {
                    setEventSourceId(event.target.value);
                    setEventPage(1);
                  }}
                  aria-label="Filter by source"
                >
                  <option value="">All Sources</option>
                  {eventSourceOptions.map((source) => (
                    <option key={source.id} value={source.id}>
                      {source.name}
                    </option>
                  ))}
                </select>
              </label>
              {(eventQuery || eventDate || eventSourceId) && (
                <button
                  type="button"
                  className="filter-button"
                  onClick={() => {
                    setEventQuery("");
                    setEventDate("");
                    setEventSourceId("");
                    setEventPage(1);
                  }}
                >
                  Clear filters
                </button>
              )}
            </div>

            <div className="results-heading">
              <div>
                <strong>{eventList?.total ?? 0} events</strong>
                {eventDate && <span> on {eventDate} (JST)</span>}
              </div>
              <span>Sorted by latest</span>
            </div>

            {eventListState.error && (
              <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
                {eventListState.error}
              </div>
            )}

            {eventListState.loading ? (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-6 text-sm text-slate-600">Loading events...</div>
            ) : !eventListState.error && (eventList?.items.length ?? 0) === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-8 text-center text-sm text-slate-600">
                {eventQuery || eventDate || eventSourceId
                  ? "No events match these filters."
                  : "No events yet. Events appear here after collected articles are processed by AI."}
              </div>
            ) : (
              <div className="event-list event-list-full">
                {eventList?.items.map((item) => (
                  <button key={item.id} type="button" className="event-card" onClick={() => navigate(`/events/${item.id}`)}>
                    <div className="event-top">
                      <span className="event-badges">
                        <span className="ai-badge">AI summary</span>
                        {humanizeEventProcessing(item.processingStatus) && (
                          <span className="ai-badge">{humanizeEventProcessing(item.processingStatus)}</span>
                        )}
                      </span>
                      <span className="event-time">{formatJst(item.latestArticleAt)}</span>
                    </div>
                    <h3>{item.titleVi}</h3>
                    {item.summaryVi && <p>{item.summaryVi}</p>}
                    <div className="event-meta">
                      <span className="event-sources">{item.sources.map((source) => source.name).join(" · ")}</span>
                      <span>
                        {item.articleCount} {item.articleCount === 1 ? "article" : "articles"}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {(eventList?.total ?? 0) > 0 && (
              <div className="mt-4 flex items-center justify-between text-sm text-slate-500">
                <span>
                  Page {eventList?.page ?? 1} of {Math.max(1, Math.ceil((eventList?.total ?? 0) / (eventList?.pageSize ?? 20)))}
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-sm disabled:opacity-50"
                    disabled={eventPage <= 1 || eventListState.loading}
                    onClick={() => setEventPage((page) => Math.max(1, page - 1))}
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-sm disabled:opacity-50"
                    disabled={eventListState.loading || eventPage * (eventList?.pageSize ?? 20) >= (eventList?.total ?? 0)}
                    onClick={() => setEventPage((page) => page + 1)}
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {eventIdRoute && (
          <div className="mt-8">
            <button type="button" className="back-link" onClick={() => navigate("/events")}>
              <span>←</span> Back to events
            </button>

            {eventDetailState.loading ? (
              <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-6 text-sm text-slate-600">Loading event...</div>
            ) : eventDetailState.error ? (
              <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
                {eventDetailState.error}
              </div>
            ) : eventDetail ? (
              <>
                <article className="event-detail mt-4">
                  <div className="event-detail-top">
                    <div>
                      <span className="event-badges">
                        <span className="ai-badge">AI summarized</span>
                        {humanizeEventProcessing(eventDetail.processingStatus) && (
                          <span className="ai-badge">{humanizeEventProcessing(eventDetail.processingStatus)}</span>
                        )}
                      </span>
                      <h1>{eventDetail.titleVi}</h1>
                      <p className="event-detail-meta">
                        First seen {formatJst(eventDetail.firstSeenAt)} · Last updated {formatJst(eventDetail.latestArticleAt)}
                      </p>
                    </div>
                  </div>
                  <section className="summary-block">
                    <div className="summary-label">Summary</div>
                    <p>{eventDetail.summaryVi ?? "Summary is not available yet."}</p>
                  </section>
                </article>

                <div className="event-detail-grid">
                  <section className="articles-card related-card">
                    <div className="section-heading">
                      <div>
                        <h2>Related Articles</h2>
                        <p>
                          {eventDetail.articleCount} {eventDetail.articleCount === 1 ? "article" : "articles"} grouped into this event
                        </p>
                      </div>
                    </div>
                    {eventDetail.articles.map((article) => (
                      <div className="related-article" key={article.id}>
                        <span className="source-avatar">{article.sourceName.slice(0, 2).toUpperCase()}</span>
                        <div>
                          <span className="related-source">{article.sourceName}</span>
                          <h3 lang={article.originalLanguage ?? undefined}>{article.originalTitle}</h3>
                          <p>Published {formatJst(article.publishedAt ?? article.discoveredAt)}</p>
                        </div>
                        <a href={article.originalUrl} target="_blank" rel="noreferrer noopener" aria-label={`Read ${article.originalTitle}`}>
                          ↗
                        </a>
                      </div>
                    ))}
                  </section>

                  <aside className="sources-card articles-card">
                    <h2>Sources</h2>
                    <p>
                      {eventDetail.sources.length} {eventDetail.sources.length === 1 ? "source" : "independent sources"} reported this event.
                    </p>
                    {eventDetail.sources.map((source) => (
                      <button
                        key={source.id}
                        type="button"
                        onClick={() => window.open(source.websiteUrl, "_blank", "noopener,noreferrer")}
                      >
                        <span className="source-avatar">{source.name.slice(0, 2).toUpperCase()}</span>
                        <span>
                          {source.name}
                          <small>View source</small>
                        </span>
                        <span aria-hidden="true">↗</span>
                      </button>
                    ))}
                  </aside>
                </div>
              </>
            ) : null}
          </div>
        )}

        {currentPath === "/settings" && (
          <div className="mt-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="mb-1 text-lg font-semibold text-slate-900">Digest Settings</h2>
            <p className="mb-4 text-sm text-slate-500">Your Daily Digest is delivered to this address at 07:00 JST.</p>
            {settingsState.saved && (
              <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800" role="status">
                Settings saved. Future digests will be sent to {settingsEmail}.
              </div>
            )}
            {settingsState.error && (
              <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
                {settingsState.error}
              </div>
            )}
            {settingsState.loading && !settingsEmail ? (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-6 text-sm text-slate-600">Loading settings...</div>
            ) : (
              <form onSubmit={handleSaveSettings} className="space-y-4 text-sm text-slate-700" noValidate>
                <div>
                  <label htmlFor="recipient-email" className="mb-2 block text-sm font-medium text-slate-700">
                    Recipient email
                  </label>
                  <input
                    id="recipient-email"
                    type="email"
                    value={settingsEmail}
                    onChange={(event) => {
                      setSettingsEmail(event.target.value);
                      setSettingsState((current) => ({ ...current, saved: false }));
                    }}
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none transition focus:border-[#3157d5] focus:bg-white focus:ring-2 focus:ring-[#3157d5]/15"
                    required
                  />
                </div>
                <div className="rounded-xl bg-slate-50 p-3">Timezone: Asia/Tokyo (read-only)</div>
                <div className="rounded-xl bg-slate-50 p-3">Digest send time: 07:00 JST (read-only)</div>
                <p className="text-xs text-slate-500">The digest contains news from the previous calendar day in Asia/Tokyo.</p>
                <div className="flex flex-wrap justify-end gap-3 pt-2">
                  <button
                    type="button"
                    className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 disabled:opacity-50"
                    disabled={recentDigests.length === 0}
                    onClick={() => recentDigests[0] && navigate(`/digests/${recentDigests[0].id}`)}
                  >
                    {recentDigests.length === 0 ? "No digest to preview yet" : "Preview latest digest"}
                  </button>
                  <button type="submit" className="rounded-xl bg-[#3157d5] px-4 py-2 text-sm font-semibold text-white disabled:opacity-70" disabled={settingsState.saving}>
                    {settingsState.saving ? "Saving..." : "Save changes"}
                  </button>
                </div>
              </form>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
