import { HomeSections } from "@/components/HomeSections";
import { HomeScrollReset } from "@/components/HomeScrollReset";
import { StudioHashRedirect } from "@/components/StudioHashRedirect";

// Section order/visibility (including Articles, off by default) is now
// admin-controlled via site_contents.page_sections_order — see
// HomeSections.tsx and the Visual Editor's SectionManager controls.

export default function Home() {
  return (
    <>
      <StudioHashRedirect />
      <HomeScrollReset />
      <HomeSections />
    </>
  );
}
