/**
 * Source-level guard for the Console page-anatomy contract.
 *
 * Runtime tests cover the individual workflows; this guard prevents a routed surface
 * from quietly re-introducing a private width/header/motion grammar. Host-tab pages own
 * the shared PageContainer/PageHeader while their child panels remain embeddable.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(process.cwd(), "src");

const PRIMARY_SURFACES = [
  "soc/pages/Analytics.tsx",
  "soc/pages/Approvals.tsx",
  "soc/pages/Audit.tsx",
  "soc/pages/Baseline.tsx",
  "soc/pages/BatchJobs.tsx",
  "soc/pages/Campaigns.tsx",
  "soc/pages/Cases.tsx",
  "soc/pages/Cost.tsx",
  "soc/pages/Dashboards.tsx",
  "soc/pages/Docs.tsx",
  "soc/pages/Inbox.tsx",
  "soc/pages/Intelligence.tsx",
  "soc/pages/Knowledge.tsx",
  "soc/pages/Metrics.tsx",
  "soc/pages/Models.tsx",
  "soc/pages/Overview.tsx",
  "soc/pages/Scans.tsx",
  "soc/pages/Settings.tsx",
  "soc/pages/Sources.tsx",
  "soc/pages/Standup.tsx",
  "soc/pages/Tuning.tsx",
  "soc/pages/Workspace.tsx",
  "soc/components/UnifiedLogsSheet.tsx",
] as const;

const source = (relative: string) =>
  readFileSync(path.join(SRC, relative), "utf8");

describe("Console route visual standard", () => {
  it.each(PRIMARY_SURFACES)(
    "%s composes the shared page container and header",
    (file) => {
      const text = source(file);
      expect(
        text,
        `${file} must use the one routed-page width authority`,
      ).toContain("<PageContainer");
      expect(
        text,
        `${file} must use the one routed-page heading/action authority`,
      ).toContain("<PageHeader");
    },
  );

  it.each(PRIMARY_SURFACES)(
    "%s does not attach a second route-entry fade to PageContainer",
    (file) => {
      expect(source(file)).not.toMatch(
        /<PageContainer\b[^>]*className="[^"]*animate-fade-in/,
      );
    },
  );

  it("keeps the custom split workspace and tab host exceptions explicit", () => {
    const manager = source("soc/pages/CaseManager.tsx");
    expect(manager).toContain("<PageContainer");
    expect(manager).toContain('variant="fluid"');
    expect(manager).toContain("w-auto sm:-mx-2 lg:-mx-4");
    expect(manager).toContain("2xl:-mx-8");
    expect(manager).toContain('role="separator"');

    const home = source("soc/pages/Home.tsx");
    expect(home).toContain("<Overview");
    expect(home).toContain("<Standup");
    expect(home).not.toContain("<PageHeader");
  });

  it("keeps every embedded Case Manager tab on one shared content rail", () => {
    const shared = source("soc/pages/casedetail/shared.tsx");
    expect(shared).toContain("export const CASE_MANAGER_PANEL_PADDING");
    expect(shared).toContain("px-4 py-4 sm:px-5 sm:py-5 lg:px-6");

    for (const file of [
      "soc/pages/casedetail/OverviewPanel.tsx",
      "soc/pages/casedetail/TimelinePanel.tsx",
      "soc/pages/casedetail/InvestigationPanel.tsx",
      "soc/pages/casedetail/ThreatContextPanel.tsx",
      "soc/pages/casedetail/CollaborationPanel.tsx",
      "soc/pages/casedetail/CaseChatPanel.tsx",
    ]) {
      expect(source(file), `${file} must reuse the Case Manager content rail`).toContain(
        "CASE_MANAGER_PANEL_PADDING",
      );
    }
  });

  it("keeps Workspace Chat in the focused route container without a detached embedded toolbar", () => {
    const workspace = source("soc/pages/Workspace.tsx");
    const chat = source("soc/pages/Chat.tsx");
    const history = source("soc/components/ChatHistoryRail.tsx");

    expect(workspace).toContain('<PageContainer variant="fixed">');
    expect(workspace).toContain("<Chat caseId={caseId} />");
    expect(workspace).not.toContain("<Chat embedded");
    expect(chat).toContain("actions={actions}");
    expect(chat).toContain("<ChatHistoryRail");
    expect(history).toContain('aria-label="Conversation history"');
    expect(chat).toContain('presentation="workspace"');
  });

  it("resets row-start dividers when flat telemetry strips wrap", () => {
    const cases = source("soc/pages/Cases.tsx");
    const metrics = source("soc/pages/Metrics.tsx");
    const sources = source("soc/pages/Sources.tsx");

    for (const page of [cases, metrics]) {
      expect(page).toContain("sm:[&>*:nth-child(3n+1)]:border-l-0");
      expect(page).toContain("xl:[&>*:first-child]:border-l-0");
    }
    expect(sources).toContain("sm:[&>*:first-child]:border-l-0");
  });
});
