import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'

/**
 * Top-bar search state. The search input in the app shell filters the
 * My Projects list — it is a real filter, not a decorative control.
 * (Phase 1 has no projects, so the filter operates on an empty list
 * and reports "no matches" honestly.)
 */
interface SearchState {
  query: string
  setQuery: (q: string) => void
}

const SearchContext = createContext<SearchState>({ query: '', setQuery: () => {} })

export function SearchProvider({ children }: { children: ReactNode }) {
  const [query, setQuery] = useState('')
  const value = useMemo(() => ({ query, setQuery }), [query])
  return <SearchContext.Provider value={value}>{children}</SearchContext.Provider>
}

export function useProjectSearch(): SearchState {
  return useContext(SearchContext)
}
