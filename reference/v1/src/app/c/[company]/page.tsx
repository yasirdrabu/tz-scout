import { redirect } from "next/navigation";

export default async function CompanyHome({ params }: { params: Promise<{ company: string }> }) {
  const { company } = await params;
  redirect(`/c/${company}/buyers`);
}
