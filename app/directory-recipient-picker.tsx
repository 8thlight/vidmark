"use client";

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { ChevronDown, LoaderCircle, LockKeyhole, Search, UsersRound, X } from "lucide-react";
import { avatarDataUri } from "./profile-onboarding";
import { searchVidmarkUsers, type DirectoryUser } from "./vidmark-client";

type RecipientOption = { id: string; user: DirectoryUser };

export function DirectoryRecipientPicker({ actionLabel, disabled = false, onSelect }: { actionLabel: string; disabled?: boolean; onSelect: (user: DirectoryUser) => Promise<void> }) {
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const normalized = query.trim().toLowerCase();
  const options = useMemo<RecipientOption[]>(() => normalized.length < 2 ? [] : users.map((user) => ({ id: `recipient-${actionLabel.toLowerCase().replaceAll(" ", "-")}-${user.userId}`, user })), [actionLabel, normalized.length, users]);

  useEffect(() => {
    if (!open || normalized.length < 2) return;
    let active = true;
    const timer = window.setTimeout(() => {
      setSearching(true);
      void searchVidmarkUsers(normalized).then((matches) => {
        if (active) setUsers(matches);
      }).catch(() => {
        if (active) setUsers([]);
      }).finally(() => {
        if (active) setSearching(false);
      });
    }, 240);
    return () => { active = false; window.clearTimeout(timer); };
  }, [normalized, open]);

  const choose = async (option: RecipientOption) => {
    await onSelect(option.user);
    setQuery("");
    setUsers([]);
    setOpen(false);
    setActiveIndex(0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") { setOpen(false); return; }
    if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); setActiveIndex((current) => Math.min(current + 1, Math.max(0, options.length - 1))); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((current) => Math.max(0, current - 1)); return; }
    if (event.key === "Enter" && open && options[activeIndex]) { event.preventDefault(); void choose(options[activeIndex]); }
  };

  return <div className="recipient-picker" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}>
    <div className="recipient-input-shell">
      <Search aria-hidden="true" />
      <input role="combobox" aria-expanded={open} aria-controls="recipient-results" aria-autocomplete="list" aria-activedescendant={open && options[activeIndex] ? options[activeIndex].id : undefined} autoComplete="off" value={query} placeholder="Search by name or email" onFocus={() => setOpen(true)} onChange={(event) => { setActiveIndex(0); setQuery(event.target.value); setOpen(true); if (event.target.value.trim().length < 2) { setUsers([]); setSearching(false); } }} onKeyDown={onKeyDown} />
      {searching ? <LoaderCircle className="recipient-spinner" aria-label="Searching" /> : <button type="button" aria-label={query ? "Clear recipient search" : "Show recipient search"} onMouseDown={(event) => event.preventDefault()} onClick={() => { if (query) { setQuery(""); setUsers([]); setSearching(false); } else setOpen(!open); }}>{query ? <X aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}</button>}
    </div>
    {open ? <div id="recipient-results" className="recipient-results" role="listbox" aria-label="Vidmark recipients">
      {options.map((option, index) => {
        const profile = option.user.profile;
        return <button id={option.id} className={`recipient-option ${index === activeIndex ? "active" : ""}`} role="option" aria-selected={index === activeIndex} key={option.id} disabled={disabled} onMouseEnter={() => setActiveIndex(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => void choose(option)}><img src={avatarDataUri(profile.avatarStyle, profile.avatarSeed)} alt="" /><span><b>{profile.name}</b><small>{profile.email}</small></span><em>{actionLabel}</em></button>;
      })}
      {normalized.length < 2 ? <div className="recipient-empty"><UsersRound aria-hidden="true" /><span><b>Find a Vidmark user</b><small>Type at least two characters from their name or email.</small></span></div> : null}
      {normalized.length >= 2 && !searching && !options.length ? <div className="recipient-empty"><Search aria-hidden="true" /><span><b>No registered user found</b><small>Vidmark searches registered profiles. It does not send email.</small></span></div> : null}
      <footer><LockKeyhole aria-hidden="true" /><span>Direct shares are end-to-end encrypted for every registered recipient device.</span></footer>
    </div> : null}
  </div>;
}
