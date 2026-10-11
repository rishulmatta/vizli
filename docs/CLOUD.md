# Optional Supabase cloud library

Implementation: `apps/web/src/cloud/CloudSync.tsx`. Default component props: `{project, onLoad, onNotice}`. Uses a native accessible modal dialog and self-contained styling. Missing configuration shows an honest setup state and does not create a client or claim to save remotely.

## Configure

1. Create or select your own Supabase project. No project has been provisioned by this implementation.
2. Apply `supabase/migrations/202610080001_projects.sql` with the Supabase SQL editor, or link the local CLI and apply migrations. It creates `public.projects` and authenticated-owner row-level-security policies. Anonymous users have no table access.
3. Enable email authentication. In Auth URL configuration, add the exact local and deployed application URLs to allowed redirects. Set the site URL appropriately. The component requests a magic link redirect to the current origin and pathname; the default Supabase email template uses a magic link. Configure SMTP for delivery beyond development quotas as needed.
4. Set public browser configuration in `apps/web/.env.local`:

   ```env
   VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
   VITE_SUPABASE_ANON_KEY=YOUR_PUBLIC_ANON_OR_PUBLISHABLE_KEY
   ```

   These values are bundled into the frontend. Never use a service-role/secret key here. Restart Vite or rebuild for changes to take effect.
5. Open Cloud, sign in with an email link, and explicitly save a project. Open another browser/device and sign in to load it.

Supabase references checked during implementation: [email sign-in](https://supabase.com/docs/reference/javascript/auth-signinwithotp), [row-level security](https://supabase.com/docs/guides/database/postgres/row-level-security).

## Behavior and data

- Cloud saving is explicit. Local autosave and server persistence are separate. Saving writes a snapshot and does not replace the local scene or trigger autosave loops.
- Project IDs are scoped to the user through composite `(user_id,id)` primary key. Saving the same project ID replaces that user's cloud copy. Cloud listing shows the 100 most recently updated projects.
- Loading validates all data using the shared `ProjectSchema` before invoking `onLoad`. If the current project changed during the fetch, loading is refused to avoid overwriting concurrent work.
- Requests use AbortController plus generation checks. Closing, replacing a request, unmounting, or changing account invalidates pending results. Auth operations cannot necessarily be cancelled upstream; stale UI callbacks are ignored.
- Sign out affects the current browser session. Auth sessions use Supabase's normal client-side persistence. Local workspace data remains present after sign out; this is a personal local application, not an isolated multi-user kiosk.
- RLS is the database enforcement boundary. Client user filters are additional narrowing, not authorization.
- Images remain embedded data URLs or remote references in project JSON. Separate Supabase Storage uploads are not implemented. Large embedded assets can make snapshots expensive.
- No realtime collaboration, conflict merge, cloud revision history, project deletion UI, or automatic background cloud synchronization yet. Last explicitly saved snapshot wins for the same ID.

## Verification and future work

Type checking is run with the web workspace. Live authentication, email delivery, and owner isolation require a configured Supabase account and must be verified before public deployment. No account credentials or cloud resources were available/provisioned here. The SQL policies should be tested with two separate authenticated users: each can create/read/update/delete their own ID, cannot read or overwrite the other's row, and anonymous requests cannot access either.

Validation update: web TypeScript check passed with Supabase SDK installed. Aborting a save prevents stale UI updates but cannot retract a database write already accepted by Supabase; explicitly saving should be understood as a committed user action.

Browser verification: integrated Cloud button opens the native dialog with missing-configuration information; Escape closes it. Verified in real Chrome without Supabase configuration. Auth and database operations remain unverified against a live project.
