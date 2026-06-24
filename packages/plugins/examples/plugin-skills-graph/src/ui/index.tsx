import {
  type PluginPageProps,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";
import { GRAPH_HTML } from "./graph-html.js";

const PAGE_ROUTE = "skills-graph";

function pluginPagePath(companyPrefix: string | null | undefined): string {
  return companyPrefix ? `/${companyPrefix}/${PAGE_ROUTE}` : `/${PAGE_ROUTE}`;
}

export function SkillsGraphSidebarLink({ context }: PluginSidebarProps) {
  const href = pluginPagePath(context.companyPrefix);
  const isActive =
    typeof window !== "undefined" && window.location.pathname === href;
  return (
    <a
      href={href}
      aria-current={isActive ? "page" : undefined}
      className={[
        "flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium transition-colors",
        isActive
          ? "bg-accent text-foreground"
          : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
      ].join(" ")}
    >
      <span className="relative shrink-0">
        <svg
          viewBox="0 0 24 24"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="6" cy="6" r="2.2" />
          <circle cx="18" cy="6" r="2.2" />
          <circle cx="12" cy="13" r="2.2" />
          <circle cx="6" cy="19" r="2.2" />
          <circle cx="18" cy="19" r="2.2" />
          <path d="M7.5 7.3 10.7 11.7" />
          <path d="M16.5 7.3 13.3 11.7" />
          <path d="M10.6 14.6 7.4 17.6" />
          <path d="M13.4 14.6 16.6 17.6" />
        </svg>
      </span>
      <span className="flex-1 truncate">Skills Graph</span>
    </a>
  );
}

export function SkillsGraphPage({ context }: PluginPageProps) {
  // FRE-1613 #4: the graph is a full-bleed iframe that otherwise covers the
  // whole app. Provide an explicit way back to the main Paperclip interface.
  const homeHref = context?.companyPrefix ? `/${context.companyPrefix}` : "/";
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          height: "44px",
          flexShrink: 0,
          padding: "0 14px",
          background: "#0a0a0a",
          borderBottom: "1px solid #1f1f1f",
          fontFamily: "'Outfit', system-ui, sans-serif",
        }}
      >
        <a
          href={homeHref}
          aria-label="Back to Paperclip"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            color: "#cfcfcf",
            textDecoration: "none",
            fontSize: "13px",
            fontWeight: 500,
            padding: "5px 10px",
            borderRadius: "8px",
            border: "1px solid #1f1f1f",
            background: "#111",
            transition: "all 0.15s",
          }}
        >
          <span aria-hidden="true" style={{ fontSize: "15px", lineHeight: 1 }}>
            &#8592;
          </span>
          Back to Paperclip
        </a>
        <span style={{ fontSize: "13px", fontWeight: 600, color: "#e0e0e0" }}>
          Skills Graph
        </span>
      </div>
      <iframe
        title="Skills Graph"
        srcDoc={GRAPH_HTML}
        style={{
          flex: 1,
          width: "100%",
          height: "100%",
          border: "none",
          background: "#0f0f1a",
        }}
        sandbox="allow-scripts allow-same-origin"
      />
    </div>
  );
}
