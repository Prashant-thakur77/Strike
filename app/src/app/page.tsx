import { Agents } from "@/components/landing/Agents";
import { BuiltOn } from "@/components/landing/BuiltOn";
import { Closing } from "@/components/landing/Closing";
import { Hero } from "@/components/landing/Hero";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { Live } from "@/components/landing/Live";
import { Manifesto } from "@/components/landing/Manifesto";
import { Numbers } from "@/components/landing/Numbers";
import { Safety } from "@/components/landing/Safety";
import { SiteNav } from "@/components/site/SiteNav";

export default function Landing() {
  return (
    <>
      <SiteNav />
      <main id="main">
        <Hero />
        <Manifesto />
        <Numbers />
        <HowItWorks />
        <Agents />
        <Live />
        <Safety />
        <BuiltOn />
        <Closing />
      </main>
    </>
  );
}
