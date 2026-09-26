-- Public storage bucket for static marketing assets — currently the Open Graph
-- social card (og/og.png) referenced by index.html as og:image / twitter:image.
--
-- Design notes (why it is built this way):
--
--   * The bucket is PUBLIC on purpose: social link scanners (Slack, X, WhatsApp,
--     Facebook, Discord) fetch og:image WITHOUT an Authorization header. A
--     private bucket returns 400/401 to those crawlers and the card never
--     renders in chat previews.
--   * `public = true` alone is NOT enough: storage.objects has RLS enabled, so
--     every object row is still gated by policy. Anonymous reads therefore come
--     from an explicit SELECT policy on storage.objects, not from the flag.
--   * Writes and deletes are restricted to admins (public.is_admin(), which
--     already spans 'admin' and 'superadmin'), so staff can refresh og.png via
--     the dashboard or CLI without opening the bucket to arbitrary uploads.
--   * file_size_limit and allowed_mime_types mirror the live bucket exactly
--     (5 MB, PNG only) so a fresh environment reproduces it byte for byte.
--
-- Idempotent: safe to replay (bucket upsert, policies drop+recreate).

-- ----------------------------- 1. the bucket ------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('og', 'og', true, 5242880, array['image/png']::text[])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ----------------------- 2. anonymous read policy --------------------------

drop policy if exists "Public read og assets" on storage.objects;
create policy "Public read og assets"
  on storage.objects for select
  using (bucket_id = 'og');

-- -------------------- 3. admin-only write / delete -------------------------

drop policy if exists "Admin manage og assets" on storage.objects;
create policy "Admin manage og assets"
  on storage.objects for all
  using (bucket_id = 'og' and public.is_admin())
  with check (bucket_id = 'og' and public.is_admin());
