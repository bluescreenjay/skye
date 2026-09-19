# @ai-browser/extension

Chrome MV3 extension shell (Vite + CRXJS). It will host the two product UIs,
Home (new tab) and the Sidebar (Side Panel), and capture tab state.

Currently only a background service worker stub that imports the domain types
from `@ai-browser/shared`. Tab ingestion lands in feature 002, Home in 005 and
the Sidebar in 006. The Vite config that builds the extension arrives with
feature 002.
