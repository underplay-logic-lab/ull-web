import { Hero } from "@/components/Hero";
import { Studio } from "@/components/Studio";
import { Products } from "@/components/Products";
import { Pricing } from "@/components/Pricing";
import { Articles } from "@/components/Articles";
import { Contact } from "@/components/Contact";
import { HomeScrollReset } from "@/components/HomeScrollReset";

export default function Home() {
  return (
    <>
      <HomeScrollReset />
      <Hero />
      <Studio />
      <Products />
      <Pricing />
      <Articles />
      <Contact />
    </>
  );
}
