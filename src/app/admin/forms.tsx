"use client";

import { ActionForm, Dialog, SubmitButton } from "@/components/client";
import { Field } from "@/components/ui";
import { addMembershipAction, createCompanyAction, createUserAction } from "./actions";
import { ROLE_NAME, ROLES } from "./roles";

type Option = { id: string; name: string };

function RoleSelect({ name = "role", defaultValue = "OPERATOR" }: { name?: string; defaultValue?: string }) {
  return (
    <select name={name} className="input" defaultValue={defaultValue}>
      {ROLES.map((r) => (
        <option key={r} value={r}>
          {ROLE_NAME[r]}
        </option>
      ))}
    </select>
  );
}

export function NewCompanyDialog() {
  return (
    <Dialog trigger="New company" title="New company" variant="primary">
      {(close) => (
        <ActionForm action={createCompanyAction} onDone={(r) => r.ok && close()} className="space-y-3">
          <Field label="Name">
            <input name="name" className="input" required placeholder="Northwind Sample Co" />
          </Field>
          <Field label="Short name" hint="Used in the web address. Lowercase letters, numbers and hyphens.">
            <input name="slug" className="input font-mono" required placeholder="northwind" pattern="[a-z0-9]+(-[a-z0-9]+)*" />
          </Field>
          <Field label="Currency" hint="Three-letter code.">
            <input name="currency" className="input w-24 uppercase" defaultValue="USD" maxLength={3} />
          </Field>
          <p className="text-2xs text-ink-muted">The company starts with default settings and every integration on sample data.</p>
          <SubmitButton pendingText="Creating...">Create company</SubmitButton>
        </ActionForm>
      )}
    </Dialog>
  );
}

export function NewUserDialog({ companies }: { companies: Option[] }) {
  return (
    <Dialog trigger="Add person" title="Add a person" variant="primary">
      {(close) => (
        <ActionForm action={createUserAction} onDone={(r) => r.ok && close()} className="space-y-3">
          <Field label="Name">
            <input name="name" className="input" required />
          </Field>
          <Field label="Work email" hint="They sign in with this Microsoft 365 account.">
            <input name="email" type="email" className="input" required />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="isAdmin" className="accent-accent" />
            Taazaa admin (manages companies, people and integrations)
          </label>
          <div className="grid grid-cols-2 gap-3 border-t border-line pt-3">
            <Field label="Give access to (optional)">
              <select name="companyId" className="input" defaultValue="">
                <option value="">No company yet</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Role">
              <RoleSelect />
            </Field>
          </div>
          <SubmitButton pendingText="Adding...">Add person</SubmitButton>
        </ActionForm>
      )}
    </Dialog>
  );
}

export function AddMembershipForm({ users, companies }: { users: Option[]; companies: Option[] }) {
  return (
    <ActionForm action={addMembershipAction} className="grid items-end gap-3 p-4 sm:grid-cols-[1fr_1fr_160px_auto]">
      <Field label="Person">
        <select name="userId" className="input" defaultValue="" required>
          <option value="" disabled>
            Pick a person
          </option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Company">
        <select name="companyId" className="input" defaultValue="" required>
          <option value="" disabled>
            Pick a company
          </option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Role">
        <RoleSelect />
      </Field>
      <SubmitButton pendingText="Adding...">Give access</SubmitButton>
    </ActionForm>
  );
}
