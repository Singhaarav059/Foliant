"use client";

// Carries a result into the next tool ("Continue with …") without re-uploading.
// Read during the next tool's first render, cleared once it has mounted.
let pending: File[] | null = null;

export function handOff(files: File[]) {
  pending = files;
}

export const peekHandoff = () => pending;

export function clearHandoff() {
  pending = null;
}
