"use client";

import { ActionForm, Dialog, SubmitButton } from "@/components/client";
import { Field } from "@/components/ui";
import type { FormAction } from "@/server/action";

export function CaseStudyDialog({ action, trigger, initial }: { action: FormAction; trigger: string; initial?: { title: string; client: string; industry: string; result: string; link: string | null } }) {
  return (
    <Dialog trigger={trigger} title={initial ? "Edit case study" : "New case study"} variant={initial ? "ghost" : "primary"} size={initial ? "sm" : "md"}>
      {(close) => (
        <ActionForm action={action} onDone={(r) => r.ok && close()} className="space-y-3">
          <Field label="Client">
            <input name="client" className="input" defaultValue={initial?.client} required />
          </Field>
          <Field label="Title">
            <input name="title" className="input" defaultValue={initial?.title} required />
          </Field>
          <Field label="Industry" hint="Used to match proof to segments and leads.">
            <input name="industry" className="input" defaultValue={initial?.industry} required />
          </Field>
          <Field label="Result" hint="The measurable outcome.">
            <textarea name="result" className="input" rows={3} defaultValue={initial?.result} required />
          </Field>
          <Field label="Link">
            <input name="link" className="input" defaultValue={initial?.link ?? ""} placeholder="https://" />
          </Field>
          <SubmitButton pendingText="Saving...">Save</SubmitButton>
        </ActionForm>
      )}
    </Dialog>
  );
}
