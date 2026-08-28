import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getAdminUser } from "@/lib/adminAuth";

// Full-bleed, desktop-only shell for the workflow UI builder. Deliberately
// its own route group so it escapes /admin/layout.tsx's max-w-6xl frame —
// the 3-pane workstation needs the whole viewport. Auth is the same
// ADMIN_EMAILS gate as /admin.
export default async function WorkflowBuilderLayout({ children }: { children: ReactNode }) {
  const user = await getAdminUser();
  if (!user) redirect("/#studio");

  // pt-16 clears the app's fixed 4rem <Header>; the shell sizes its own
  // panes to the remaining viewport height.
  return (
    <div className="w-full min-w-[1280px] overflow-x-auto bg-background pt-16 text-foreground">
      {children}
    </div>
  );
}
