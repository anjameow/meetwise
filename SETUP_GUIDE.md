# Setting up Meetwise — a guide for non-technical people

You don't need to install anything or use a terminal. Everything happens in your web browser by clicking and copy-pasting. Plan for about **45 minutes**.

**Three free services do the work:**
- **GitHub** stores the app's code. It's already at https://github.com/anjameow/meetwise.
- **Supabase** is the "back office": the database, logins, file storage, and the matching engine.
- **Vercel** puts the website online so people can open it on their phones.

**Golden rule:** Supabase gives you two kinds of keys. The **public** key (called *publishable* or *anon*) is safe to put in the website. The **secret** key (called *secret* or *service_role*) is a master key. Only paste it where this guide tells you to (Part 9), and never share it.

If anything shows an error, stop and copy the exact message to Claude. Don't guess.

---

## Part 1 — Create your Supabase project (5 min)

1. Go to https://supabase.com and click **Start your project**. Sign up; using your GitHub account is easiest.
2. Click **New project**.
3. Fill in:
   - **Name:** `meetwise`
   - **Database password:** click **Generate a password**, then **save it in your password manager**.
   - **Region:** the one closest to where your events happen.
4. Click **Create new project** and wait 1–2 minutes until the dashboard finishes loading.

## Part 2 — Build the database (10 min, six copy-pastes)

The database is created by six files. Run them **in order, one at a time, each exactly once**.

1. In Supabase, click **SQL Editor** in the left menu.
2. In another browser tab, open the folder of files on GitHub:
   https://github.com/anjameow/meetwise/tree/main/supabase/migrations
3. For each file below, in this order:

   | # | File |
   |---|------|
   | 1 | `20261023000001_core_schema.sql` |
   | 2 | `20261023000002_security.sql` |
   | 3 | `20261023000003_attendee_rpcs.sql` |
   | 4 | `20261023000004_organiser_matching.sql` |
   | 5 | `20261023000005_admin_scheduler.sql` |
   | 6 | `20261023000006_grants_and_cron.sql` |

   - On GitHub, click the file name. Then click the **Copy raw file** button: two overlapping squares, near the top right of the file.
   - In Supabase's SQL Editor, click **+ New query**, click inside the big empty box, and paste (Ctrl+V, or Cmd+V on a Mac).
   - Click **Run** (bottom right), or press Ctrl+Enter.
   - You should see **"Success. No rows returned"**. Then do the next file.

   If Supabase asks *"this query has destructive operations, run anyway?"*, click **Run this query**. That's expected.

4. **Check it worked:** click **Table Editor** in the left menu. You should see tables such as `events`, `profiles` and `match_assignments`.

## Part 3 — Add the five server functions (10 min)

These run the matching, recommendations, private résumé links, account deletion and the timer. They're ready-made single files, so you just paste them.

1. In Supabase, click **Edge Functions** in the left menu.
2. Click **Deploy a new function**, then **Via Editor**.
3. Set the **function name** exactly as shown below. Delete the sample code in the editor, paste the code from GitHub, and click **Deploy function**.

   | Function name (type exactly) | Code to paste (open, then "Copy raw file") |
   |---|---|
   | `run-matching` | https://github.com/anjameow/meetwise/blob/main/supabase/dashboard/run-matching.ts |
   | `generate-recommendations` | https://github.com/anjameow/meetwise/blob/main/supabase/dashboard/generate-recommendations.ts |
   | `resume-url` | https://github.com/anjameow/meetwise/blob/main/supabase/dashboard/resume-url.ts |
   | `delete-account` | https://github.com/anjameow/meetwise/blob/main/supabase/dashboard/delete-account.ts |
   | `scheduler` | https://github.com/anjameow/meetwise/blob/main/supabase/dashboard/scheduler.ts |

4. **One extra step for `scheduler` only:** open it from the Edge Functions list, go to its **Details** (or **Settings**) tab, and turn **off** "Verify JWT" (it may be called "Enforce JWT verification"). Save. Leave that setting **on** for the other four.

## Part 4 — Logins (2 min)

1. Click **Authentication**, then **Sign In / Providers**. Make sure **Email** is turned on.
2. **For testing,** turn **off** "Confirm email". Supabase's built-in email sender only sends a few emails per hour, so sign-ups can get stuck waiting for an email.
   For a real event, either leave it off, or set up an email service under **Authentication → Emails → SMTP settings** (Resend, Postmark and SendGrid all work) and turn it back on.

## Part 5 — Copy your two public settings (1 min)

1. Click **Project Settings** (the gear icon), then **API Keys** (on some screens it's called **Data API**).
2. Copy these two values into a note:
   - **Project URL**, which looks like `https://abcdefgh.supabase.co`
   - The **publishable** key (or **anon public** key), a long piece of text.

Don't copy the secret / service_role key here.

## Part 6 — Put the website online with Vercel (5 min)

1. Go to https://vercel.com and choose **Sign up**, then **Continue with GitHub**.
2. Click **Add New…**, then **Project**. Find `anjameow/meetwise` and click **Import**.
   If it's not listed, click **Adjust GitHub App Permissions** and give Vercel access to `meetwise`.
3. Leave the settings as they are; Vercel detects "Vite" automatically. Open **Environment Variables** and add two:

   | Name (type exactly) | Value |
   |---|---|
   | `VITE_SUPABASE_URL` | your Project URL from Part 5 |
   | `VITE_SUPABASE_PUBLISHABLE_KEY` | your publishable / anon key from Part 5 |

4. Click **Deploy** and wait about a minute. You'll get a web address like `https://meetwise-xyz.vercel.app`. That's your app.

## Part 7 — Tell Supabase your website address (1 min)

1. In Supabase, click **Authentication**, then **URL Configuration**.
2. **Site URL:** paste your Vercel address, for example `https://meetwise-xyz.vercel.app`.
3. Under **Redirect URLs**, click **Add URL** and enter your address followed by `/**` (for example `https://meetwise-xyz.vercel.app/**`). Save.

## Part 8 — Make yourself the administrator (2 min)

1. Open your Vercel address, click **Sign in**, then **Create account**, and sign up with your own email.
2. In Supabase's **SQL Editor**, click **+ New query** and paste this, **changing the email to the one you just used**:
   ```sql
   insert into public.user_roles (user_id, role)
   select id, 'admin' from auth.users where email = 'you@example.com';
   ```
3. Click **Run**. You should see "Success. 1 rows affected". If it says **0 rows**, the email didn't match exactly.
4. Refresh the app (wait about a minute if needed). You'll now see **Organise** and **Admin** in the menu.

## Part 9 — Turn on fully automatic matching (5 min, recommended)

Without this step everything still works, but after registration closes you'll need to click **Launch matching** in the dashboard yourself. Reveal times are enforced by the server either way.

1. In Supabase, click **Database**, then **Extensions**. Search for **pg_net** and switch it on.
2. Find your **secret key:** go to **Project Settings → API Keys**, open the **Legacy API keys** tab, and copy the **service_role** key (click **Reveal**). Treat it like a bank password.
   If you can't find a Legacy tab or a service_role key, stop here and ask Claude.
3. In the **SQL Editor**, open a new query and paste this. Replace **both** placeholders: your Project URL followed by `/functions/v1`, and the service_role key.
   ```sql
   select vault.create_secret('https://abcdefgh.supabase.co/functions/v1', 'meetwise_functions_url');
   select vault.create_secret('PASTE-SERVICE-ROLE-KEY-HERE', 'meetwise_service_role_key');
   ```
4. Click **Run**. A built-in timer now checks every minute: it runs matching when registration closes, reveals matches on time, and prepares recommendations before their reveal.

## Part 10 — Try it out

1. In the app, click **Organise**, then **New event**. Fill in the name and the schedule. Times are in the timezone you choose. Click **Create draft**, then **Publish**.
2. Open the **Share** tab to download the QR code, or copy the link.
3. Open the link on your phone with a different account, join the event, and fill in your profile.
4. To see a real match you need at least two attendees whose profiles are complete.

---

## If something goes wrong

| What you see | What to do |
|---|---|
| A yellow banner saying "Supabase isn't configured yet", or a blank page | The two Vercel environment variables are missing or mistyped. Fix them in Vercel under **Settings → Environment Variables**, then **Deployments → ⋯ → Redeploy**. |
| Opening an event link gives "404" | Make sure you're on the latest version of the code (it includes `vercel.json`), then redeploy. |
| The sign-up email never arrives | Turn off "Confirm email" (Part 4), or set up an email service. |
| A red error when running a database file | Don't run more files. Copy the error and ask Claude. Please don't re-run files that already succeeded. |
| "Launch matching" says it's not available yet | Matching can only start after the registration deadline has passed. |
| Matching never runs by itself | Do Part 9, and check that `scheduler` has "Verify JWT" turned off. |
