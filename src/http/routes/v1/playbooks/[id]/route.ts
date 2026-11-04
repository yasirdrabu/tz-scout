import { archiveTemplate, deleteTemplate, duplicateTemplate, getTemplate, updateTemplate, type TemplatePatch } from '@/modules/playbooks';
import { ScoutError } from '@/platform/errors';
import { parseBody } from '../../_lib/body';
import { idAndAction, notFound } from '../../_lib/path';
import { byAction, created, noContent, v1Route } from '../../_lib/v1-route';
import { patchTemplateBody, templateOut, withSteps } from '../schemas';

// `?version=n` reads the steps of an older version; the rest of the template is as it is now.
export const GET = v1Route({ permission: 'playbooks:read' }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'playbooks');
  if (action) throw notFound();
  const asked = new URL(req.url).searchParams.get('version');
  if (asked !== null && !/^\d+$/.test(asked)) {
    throw new ScoutError({ slug: 'validation', status: 400, title: 'Check the request.', errors: [{ path: 'version', message: 'Use a version number.' }] });
  }
  return templateOut(await getTemplate(ctx, id, asked === null ? undefined : Number(asked)));
});

export const PATCH = v1Route({ permission: 'playbooks:manage' }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'playbooks');
  if (action) throw notFound();
  const patch = withSteps(await parseBody<TemplatePatch & { steps?: never }>(req, patchTemplateBody));
  return templateOut(await updateTemplate(ctx, id, patch as TemplatePatch));
});

/** 204, or 409 "This playbook has run on accounts. Retire it instead." */
export const DELETE = v1Route({ permission: 'playbooks:manage' }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'playbooks');
  if (action) throw notFound();
  await deleteTemplate(ctx, id);
  return noContent();
});

// POST /api/v1/playbooks/{id}:duplicate and :archive
export const POST = byAction('playbooks', {
  duplicate: v1Route({ permission: 'playbooks:manage' }, async (req, _principal, ctx) => created(templateOut(await duplicateTemplate(ctx, idAndAction(req, 'playbooks').id)))),
  archive: v1Route({ permission: 'playbooks:manage' }, async (req, _principal, ctx) => templateOut(await archiveTemplate(ctx, idAndAction(req, 'playbooks').id))),
});
