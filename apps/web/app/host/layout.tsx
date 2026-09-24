"use client";

import { type ReactNode } from "react";
import { HostChrome } from "../../components/chrome";

export default function HostLayout({ children }: { children: ReactNode }) {
  return <HostChrome>{children}</HostChrome>;
}