import { Workflows } from "@/components/Workflows";
import { titleFrom } from "@/lib/i18n/meta";

export const generateMetadata = titleFrom("wf.title", { path: "/workflows", description: "wf.subtitle" });

export default function WorkflowsPage() {
  return <Workflows />;
}
