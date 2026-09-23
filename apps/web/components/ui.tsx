"use client";

import type { ButtonHTMLAttributes, InputHTMLAttributes, LabelHTMLAttributes, ReactNode } from "react";

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm font-medium text-zinc-300">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className="w-full rounded-xl border border-zinc-700 bg-zinc-900 px-3.5 py-2.5 text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-violet-500"
    />
  );
}

export function Button({
  variant = "primary",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" }) {
  const styles = {
    primary:
      "bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-50 disabled:hover:bg-violet-600",
    ghost: "border border-zinc-700 text-zinc-200 hover:border-violet-500 hover:text-white",
    danger: "border border-red-900/60 text-red-400 hover:bg-red-950/40",
  }[variant];
  return (
    <button
      {...props}
      disabled={props.disabled}
      className={`rounded-xl px-4 py-2 text-sm font-semibold ${styles} ${props.className ?? ""}`}
    />
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5 ${className}`}>{children}</div>;
}

export function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="rounded-xl border border-red-900/60 bg-red-950/40 px-4 py-2.5 text-sm text-red-300">{message}</div>;
}