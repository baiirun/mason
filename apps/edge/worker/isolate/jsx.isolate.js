// JSX runtime for the server half: views are compiled into the same module but never called here.
export const jsx = () => null;
export const jsxs = jsx;
export const Fragment = Symbol("Fragment");
