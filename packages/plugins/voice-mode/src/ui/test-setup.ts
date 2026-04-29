// Vitest setup: patch React namespace for @testing-library/react compatibility with React 19
// react-dom/test-utils is removed in React 19; act lives directly in 'react'
import * as React from "react";
import { act } from "react";

// @testing-library/react 16.x checks `React.act` via CJS interop — patch it here
if (typeof (React as any).act !== "function") {
  (React as any).act = act;
}
