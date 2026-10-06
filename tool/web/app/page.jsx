"use client";

import dynamic from "next/dynamic";

// The whole tool is WebGL + window state (three, Spark, the engine): render it in the browser only.
const Root = dynamic(() => import("../src/ui/Root.jsx"), { ssr: false });

export default function Page() {
  return <Root />;
}
