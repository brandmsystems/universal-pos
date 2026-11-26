import { createContext, useContext } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { businessTypeOf, type BusinessTerms, type BusinessTypeDefinition } from '@universalpos/shared';

/**
 * The business type of the restaurant on screen, for components deep in a tree
 * that need its words or its workflow without being passed them. The value is a
 * registry entry (shared `BUSINESS_TYPES`); nothing reads a type's name.
 */
const BusinessContext = createContext<BusinessTypeDefinition>(businessTypeOf(null));

export function BusinessProvider(props: { type: BusinessTypeDefinition; children: ReactNode }): ReactElement {
  return <BusinessContext.Provider value={props.type}>{props.children}</BusinessContext.Provider>;
}

export const useBusiness = (): BusinessTypeDefinition => useContext(BusinessContext);
export const useTerms = (): BusinessTerms => useContext(BusinessContext).terms;
