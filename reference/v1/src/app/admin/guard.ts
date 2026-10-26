// Admin access. Pages 404 for anyone who isn't a Taazaa admin; actions refuse with a plain error.

import { notFound } from "next/navigation";
import { requireUser } from "@/server/context";

export async function requireAdminPage() {
  const user = await requireUser();
  if (!user.isAdmin) notFound();
  return user;
}

export async function requireAdminAction() {
  const user = await requireUser();
  if (!user.isAdmin) throw new Error("Only admins can do that.");
  return user;
}
