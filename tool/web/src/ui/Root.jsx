import { useEffect } from "react";
import { Theme } from "@astryxdesign/core/theme";
import { LayerProvider } from "@astryxdesign/core/Layer";
// Astryx's stock neutral theme, prebuilt, in dark mode -- no palette overrides.
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { App } from "./App.jsx";
import { start } from "../engine.js";

let started = false;

export default function Root() {
  useEffect(() => {
    if (started) return;   // one engine per page, however often React mounts this
    started = true;
    start();
  }, []);
  return (
    <Theme theme={neutralTheme} mode="dark">
      <LayerProvider>
        <App />
      </LayerProvider>
    </Theme>
  );
}
