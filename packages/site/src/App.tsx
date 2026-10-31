import type { Lang } from "../site.config";
import { LangContext, translator } from "./i18n";
import { Footer, HowItWorks, Install, Integrations, Iphone, Security } from "./sections/Sections";
import { Stage } from "./sections/Stage";
import { TopBar } from "./sections/TopBar";

export function App({ lang }: { lang: Lang }) {
  return (
    <LangContext.Provider value={{ lang, t: translator(lang) }}>
      <TopBar />
      <main>
        <Stage />
        <HowItWorks />
        <Security />
        <Integrations />
        <Iphone />
        <Install />
      </main>
      <Footer />
    </LangContext.Provider>
  );
}
