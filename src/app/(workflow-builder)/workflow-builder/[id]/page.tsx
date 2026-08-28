import { redirect } from "next/navigation";
import { getAdminUser } from "@/lib/adminAuth";
import { WorkflowBuilderShell } from "@/components/admin/workflow-builder/WorkflowBuilderShell";

export default async function WorkflowBuilderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await getAdminUser();
  if (!user) redirect("/#studio");

  const { id } = await params;
  return <WorkflowBuilderShell workflowId={id} />;
}
