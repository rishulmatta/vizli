import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  createClient,
  type SupabaseClient,
  type User,
} from "@supabase/supabase-js";
import { Cloud, LogOut, RefreshCw, Save, X } from "lucide-react";
import { ProjectSchema, type Project } from "@vizli/shared";
import "./cloud.css";

type Props = {
  project: Project;
  onLoad: (project: Project) => void;
  onNotice: (message: string) => void;
};
type CloudProject = { id: string; title: string; updated_at: string };
let client: SupabaseClient | null = null;
let configurationError = "";
const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
if (url && key) {
  try {
    client = createClient(url, key);
  } catch {
    configurationError =
      "The cloud URL or public key is invalid. Check the application configuration.";
  }
}

export default function CloudSync({ project, onLoad, onNotice }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(!client);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [projects, setProjects] = useState<CloudProject[]>([]);
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const account = useRef<string | null>(null);
  const currentProject = useRef(project);
  currentProject.current = project;
  const invalidate = () => {
    generation.current += 1;
    request.current?.abort();
    request.current = null;
  };
  const close = () => {
    invalidate();
    setBusy("");
    setOpen(false);
  };

  useEffect(() => {
    if (!client) return;
    let alive = true;
    const update = (next: User | null) => {
      if (!alive) return;
      if (account.current !== (next?.id ?? null)) {
        invalidate();
        account.current = next?.id ?? null;
        setProjects([]);
        setBusy("");
      }
      setUser(next);
      setAuthReady(true);
    };
    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((_event, session) =>
      update(session?.user ?? null),
    );
    // INITIAL_SESSION from onAuthStateChange establishes readiness and processes magic-link sessions.
    return () => {
      alive = false;
      invalidate();
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (open && dialog.current && !dialog.current.open)
      dialog.current.showModal();
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);

  const start = (label: string) => {
    invalidate();
    setBusy(label);
    setMessage("");
    const controller = new AbortController();
    request.current = controller;
    const ticket = generation.current;
    return {
      signal: controller.signal,
      current: () =>
        ticket === generation.current && !controller.signal.aborted,
    };
  };

  const refresh = async () => {
    if (!client || !user) return;
    const operation = start("Loading projects");
    try {
      const { data, error } = await client
        .from("projects")
        .select("id,title,updated_at")
        .eq("user_id", user.id)
        .order("updated_at", { ascending: false })
        .limit(100)
        .abortSignal(operation.signal);
      if (!operation.current()) return;
      if (error) throw error;
      setProjects(data ?? []);
    } catch (error) {
      if (operation.current())
        setMessage(
          error instanceof Error
            ? error.message
            : "Could not load projects. Check the Supabase migration and connection.",
        );
    } finally {
      if (operation.current()) setBusy("");
    }
  };

  useEffect(() => {
    if (open && user) void refresh();
  }, [open, user?.id]);

  const signIn = async (event: FormEvent) => {
    event.preventDefault();
    if (!client) return;
    const operation = start("Sending sign-in link");
    try {
      const { error } = await client.auth.signInWithOtp({
        email: email.trim(),
        options: {
          emailRedirectTo: `${window.location.origin}${window.location.pathname}`,
        },
      });
      if (!operation.current()) return;
      if (error) throw error;
      setMessage(
        "Check your email for a sign-in link. Open it to return to Vizli.",
      );
    } catch (error) {
      if (operation.current())
        setMessage(
          error instanceof Error
            ? error.message
            : "Could not send a sign-in link.",
        );
    } finally {
      if (operation.current()) setBusy("");
    }
  };

  const signOut = async () => {
    if (!client) return;
    const operation = start("Signing out");
    try {
      const { error } = await client.auth.signOut({ scope: "local" });
      if (error && operation.current()) setMessage(error.message);
    } catch {
      if (operation.current()) setMessage("Could not sign out. Try again.");
    } finally {
      if (operation.current()) setBusy("");
    }
  };

  const save = async () => {
    if (!client || !user) return;
    const snapshot = ProjectSchema.safeParse(project);
    if (!snapshot.success) {
      setMessage("This project is invalid and could not be saved.");
      return;
    }
    const operation = start("Saving project");
    try {
      const now = new Date().toISOString();
      const { error } = await client
        .from("projects")
        .upsert(
          {
            id: snapshot.data.id,
            user_id: user.id,
            title: snapshot.data.title,
            data: { ...snapshot.data, updatedAt: now },
            updated_at: now,
          },
          { onConflict: "user_id,id" },
        )
        .abortSignal(operation.signal);
      if (!operation.current()) return;
      if (error) throw error;
      setProjects((list) => [
        { id: snapshot.data.id, title: snapshot.data.title, updated_at: now },
        ...list.filter((p) => p.id !== snapshot.data.id),
      ]);
      setMessage("Saved this project snapshot to your cloud library.");
      onNotice("Project saved to cloud.");
    } catch (error) {
      if (operation.current())
        setMessage(
          error instanceof Error
            ? error.message
            : "Could not save. Check the migration and your connection.",
        );
    } finally {
      if (operation.current()) setBusy("");
    }
  };

  const load = async (id: string) => {
    if (!client || !user) return;
    const original = currentProject.current;
    const operation = start("Opening project");
    try {
      const { data, error } = await client
        .from("projects")
        .select("data")
        .eq("user_id", user.id)
        .eq("id", id)
        .abortSignal(operation.signal)
        .single();
      if (!operation.current()) return;
      if (error) throw error;
      const parsed = ProjectSchema.safeParse(data?.data);
      if (!parsed.success)
        throw new Error(
          "This cloud project uses invalid or unsupported data. Your current project is unchanged.",
        );
      if (currentProject.current !== original)
        throw new Error(
          "The current project changed while loading. Open the cloud project again when ready.",
        );
      onLoad(parsed.data);
      onNotice(`Opened “${parsed.data.title}” from cloud.`);
      close();
    } catch (error) {
      if (operation.current())
        setMessage(
          error instanceof Error
            ? error.message
            : "Could not open this project.",
        );
    } finally {
      if (operation.current()) setBusy("");
    }
  };

  return (
    <>
      <button
        type="button"
        className="viz-cloud-trigger"
        onClick={() => {
          setMessage("");
          setOpen(true);
        }}
        title="Cloud library"
      >
        <Cloud size={16} />
        <span>Cloud</span>
        {user && <i aria-label="Signed in" />}
      </button>
      <dialog
        ref={dialog}
        className="viz-cloud-dialog"
        aria-labelledby="viz-cloud-title"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
      >
        <div className="viz-cloud-body">
          <header>
            <div>
              <span className="viz-cloud-kicker">YOUR IDEAS, ANYWHERE</span>
              <h2 id="viz-cloud-title">Cloud library</h2>
            </div>
            <button
              className="viz-cloud-icon"
              aria-label="Close cloud library"
              onClick={close}
            >
              <X size={20} />
            </button>
          </header>
          {!client ? (
            <div className="viz-cloud-config">
              <Cloud size={28} />
              <h3>Local workspace, ready for cloud.</h3>
              <p>
                {configurationError ||
                  "Cloud sync has not been configured. Your local project and JSON export continue to work."}
              </p>
              <p>
                To connect, set <code>VITE_SUPABASE_URL</code> and{" "}
                <code>VITE_SUPABASE_ANON_KEY</code>, apply the projects
                migration, and restart the app. Setup instructions are in{" "}
                <code>docs/CLOUD.md</code>.
              </p>
            </div>
          ) : !authReady ? (
            <p role="status">Checking your session…</p>
          ) : !user ? (
            <form onSubmit={signIn}>
              <p>
                Sign in with an email link to save and open your presentations
                across devices.
              </p>
              <label htmlFor="viz-cloud-email">Email address</label>
              <input
                id="viz-cloud-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                required
                autoComplete="email"
              />
              <button
                className="viz-cloud-primary"
                disabled={!!busy || !email.trim()}
                type="submit"
              >
                {busy || "Send sign-in link"}
              </button>
            </form>
          ) : (
            <>
              <div className="viz-cloud-account">
                <span>{user.email}</span>
                <button disabled={!!busy} onClick={signOut}>
                  <LogOut size={14} />
                  Sign out
                </button>
              </div>
              <div className="viz-cloud-save">
                <div>
                  <strong>{project.title}</strong>
                  <small>
                    Save replaces the cloud copy with this project’s current
                    contents.
                  </small>
                </div>
                <button
                  className="viz-cloud-primary"
                  disabled={!!busy}
                  onClick={save}
                >
                  <Save size={15} />
                  Save project
                </button>
              </div>
              <div className="viz-cloud-list-title">
                <h3>Your presentations</h3>
                <button
                  disabled={!!busy}
                  onClick={refresh}
                  aria-label="Refresh cloud projects"
                >
                  <RefreshCw size={15} />
                </button>
              </div>
              <p className="viz-cloud-hint">
                Opening a cloud project replaces the current workspace. Save or
                export your current work first.
              </p>
              <div className="viz-cloud-projects">
                {!projects.length && !busy && (
                  <p>
                    No cloud projects yet. Save your first presentation above.
                  </p>
                )}
                {projects.map((item) => (
                  <button
                    key={item.id}
                    disabled={!!busy}
                    onClick={() => load(item.id)}
                  >
                    <span>
                      <strong>{item.title}</strong>
                      <small>
                        {new Date(item.updated_at).toLocaleString()}
                      </small>
                    </span>
                    <span>Open →</span>
                  </button>
                ))}
              </div>
            </>
          )}
          {busy && (
            <div className="viz-cloud-status" role="status">
              {busy}…
            </div>
          )}
          {message && (
            <div className="viz-cloud-status" role="status">
              {message}
            </div>
          )}
        </div>
      </dialog>
    </>
  );
}
