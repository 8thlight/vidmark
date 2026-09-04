"use client";

import { FormEvent, useMemo, useState } from "react";
import { createAvatar } from "@dicebear/core";
import * as bottts from "@dicebear/bottts";
import * as lorelei from "@dicebear/lorelei";
import * as notionists from "@dicebear/notionists";
import * as thumbs from "@dicebear/thumbs";
import { LockKeyhole, Shuffle, X } from "lucide-react";
import type { LearnerProfile } from "./vidmark-client";
import { saveProfile } from "./vidmark-client";

export type AvatarStyle = "bottts" | "lorelei" | "notionists" | "thumbs";
export const avatarStyleOptions: Array<{ id: AvatarStyle; label: string }> = [{ id: "bottts", label: "Bottts" }, { id: "lorelei", label: "Lorelei" }, { id: "notionists", label: "Notionists" }, { id: "thumbs", label: "Thumbs" }];
export const avatarDataUri = (style: string, seed: string) => {
  const avatarSeed = seed || "vidmark-student";
  if (style === "lorelei") return createAvatar(lorelei, { seed: avatarSeed }).toDataUri();
  if (style === "notionists") return createAvatar(notionists, { seed: avatarSeed }).toDataUri();
  if (style === "thumbs") return createAvatar(thumbs, { seed: avatarSeed }).toDataUri();
  return createAvatar(bottts, { seed: avatarSeed }).toDataUri();
};

export function ProfileOnboarding({ profile, required, onSaved, onClose }: { profile: LearnerProfile | null; required: boolean; onSaved: (profile: LearnerProfile) => void; onClose: () => void }) {
  const [name, setName] = useState(profile?.name ?? "");
  const [email, setEmail] = useState(profile?.email ?? "");
  const [avatarStyle, setAvatarStyle] = useState<AvatarStyle>((profile?.avatarStyle as AvatarStyle) ?? "bottts");
  const [avatarSeed, setAvatarSeed] = useState(profile?.avatarSeed ?? "vidmark-student");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const avatar = useMemo(() => avatarDataUri(avatarStyle, avatarSeed), [avatarSeed, avatarStyle]);
  const valid = name.trim().length > 1 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && avatarSeed.trim().length > 0;
  const submit = async (event: FormEvent) => { event.preventDefault(); if (!valid) { setError("Enter your name, a valid email, and an avatar seed."); return; } setSaving(true); setError(""); try { onSaved(await saveProfile({ name, email, avatarStyle, avatarSeed })); } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not save your profile."); } finally { setSaving(false); } };
  const shuffle = () => setAvatarSeed(crypto.randomUUID().slice(0, 8));
  return <div className="profile-overlay" role="presentation"><section className="profile-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-title">
    {!required && <button className="profile-close" type="button" aria-label="Close profile editor" onClick={onClose}><X aria-hidden="true" /></button>}
    <form onSubmit={submit}>
      <div className="profile-fields"><header><h1 id="profile-title">{profile ? "Edit your profile" : "Set up your Vidmark profile"}</h1><p>{profile ? "Update how you appear to other Vidmark learners." : "This one-time profile setup is separate from unlocking the app."}</p></header>
        <label>Name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Enter your full name" autoComplete="name" /></label>
        <label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Enter your email address" autoComplete="email" /></label>
        <p className="profile-privacy"><LockKeyhole aria-hidden="true" />Your name, email, and avatar are searchable in the Vidmark employee directory. Private course content is shared only when you choose a recipient or create a link.</p>
      </div>
      <div className="avatar-editor"><h2>Avatar</h2><img src={avatar} alt="Your customized DiceBear avatar" />
        <label>Style<select value={avatarStyle} onChange={(event) => setAvatarStyle(event.target.value as AvatarStyle)}>{avatarStyleOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
        <label>Seed<div className="seed-row"><input value={avatarSeed} onChange={(event) => setAvatarSeed(event.target.value)} /><button type="button" onClick={shuffle}><Shuffle aria-hidden="true" />Shuffle</button></div></label>
        {error ? <p className="profile-error" role="alert">{error}</p> : null}
        <div className="profile-actions">{!required && <button type="button" onClick={onClose}>Cancel</button>}<button className="primary" type="submit" disabled={!valid || saving}>{saving ? "Saving…" : profile ? "Save profile" : "Create profile"}</button></div>
      </div>
    </form>
  </section></div>;
}
