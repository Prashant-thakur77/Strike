import type { Metadata } from "next";
import { LessonsPage } from "@/components/app/lessons/LessonsPage";

export const metadata: Metadata = { title: "Lessons" };

export default function Page() {
  return <LessonsPage />;
}
