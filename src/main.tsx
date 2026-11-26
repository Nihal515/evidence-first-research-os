import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { Tour } from "./components/Tour";
import { usePath } from "./router";
import "./styles.css";

// The landing page (with three.js) loads only when someone opens "/".
const Landing = lazy(() => import("./landing/Landing"));

function Root() {
  const path = usePath();
  return (
    <>
      {path === "/" ? (
        <Suspense fallback={<div style={{ minHeight: "100vh", background: "#0c0e22" }} />}>
          <Landing />
        </Suspense>
      ) : (
        <App route={path} />
      )}
      <Tour />
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
