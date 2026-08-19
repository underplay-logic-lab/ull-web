import { Hero } from "@/components/Hero";
import { Studio } from "@/components/Studio";
import { Pricing } from "@/components/Pricing";
import { Products } from "@/components/Products";
import { Contact } from "@/components/Contact";
import { HomeScrollReset } from "@/components/HomeScrollReset";

// Articles is temporarily unrendered — component and content are kept
// in place so the section can be restored later without rebuilding it.

export default function Home() {
  return (
    <>
      <HomeScrollReset />
      <Hero />
      <Studio />
      <Pricing />
      <Products />
      <Contact />
    </>
  );
}
