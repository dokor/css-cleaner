/** Hand-authored input/report: fixtures for stage tests, NOT an implemented scan. */
import type {
  AnalysisInput,
  AnalysisReport,
  ClassSymbol,
  DiscoveredProject,
  StyleImportReference,
} from "../src/contracts.js";
import { projectPath, sourceLocation } from "../src/conventions.js";

const headerFile = projectPath("src/Header.module.scss");
const footerFile = projectPath("src/Footer.module.sass");
const appFile = projectPath("src/App.tsx");
const globalFile = projectPath("src/global.css");

export const headerButton = { scope: "module", file: headerFile, name: "button" } satisfies ClassSymbol;
export const footerButton = { scope: "module", file: footerFile, name: "button" } satisfies ClassSymbol;
const page = { scope: "global", name: "page" } satisfies ClassSymbol;

const headerImport = {
  status: "resolved",
  specifier: "./Header.module.scss",
  binding: "header",
  target: headerFile,
  scope: "module",
  location: sourceLocation(appFile, 1, 1),
} satisfies StyleImportReference;

const unknownImport = {
  status: "unknown",
  specifier: "@theme/missing.module.css",
  binding: "missing",
  reason: "Cible de l’alias absente du catalogue de styles.",
  candidates: [],
  location: sourceLocation(appFile, 2, 1),
} satisfies StyleImportReference;

export const exampleProject = {
  config: {
    rootDir: "/example/project",
    include: ["src/**"],
    exclude: ["node_modules/**", ".next/**"],
    aliases: { "@theme/*": ["src/theme/*"] },
    externalGlobals: [
      { kind: "name", name: "sr-only" },
      { kind: "pattern", pattern: { parts: [{ kind: "literal", value: "icon-" }, { kind: "unknown" }] } },
    ],
  },
  styles: [
    { file: footerFile, syntax: "sass", scope: "module", content: ".button\n  color: blue\n" },
    { file: headerFile, syntax: "scss", scope: "module", content: ".button { color: red; }\n" },
    { file: globalFile, syntax: "css", scope: "global", content: ".page { display: block; }\n" },
  ],
  react: [{
    file: appFile,
    syntax: "tsx",
    content: [
      'import header from "./Header.module.scss";',
      'import missing from "@theme/missing.module.css";',
      'import "./global.css";',
      'export const App = ({ variant }: { variant: string }) => (',
      '  <main className="page paeg">',
      '    <button className={header.button} />',
      '    <div className={header[variant]} />',
      '    <span className={`button--${variant}`} />',
      '    <aside className={missing.ghost} />',
      '  </main>',
      ');',
    ].join("\n"),
  }],
  warnings: [],
} satisfies DiscoveredProject;

export const exampleInput = {
  externalGlobals: exampleProject.config.externalGlobals,
  styles: {
    definitions: [
      { symbol: footerButton, selector: ".button", location: sourceLocation(footerFile, 1, 1) },
      { symbol: headerButton, selector: ".button", location: sourceLocation(headerFile, 1, 1) },
      { symbol: page, selector: ".page", location: sourceLocation(globalFile, 1, 1) },
    ],
    coverage: [
      { file: footerFile, scope: "module", status: "complete" },
      { file: headerFile, scope: "module", status: "complete" },
      { file: globalFile, scope: "global", status: "complete" },
    ],
    warnings: [],
  },
  jsx: {
    imports: [
      headerImport,
      unknownImport,
      { status: "resolved", specifier: "./global.css", target: globalFile, scope: "global", location: sourceLocation(appFile, 3, 1) },
    ],
    usages: [
      { kind: "static", name: "page", reference: { scope: "global" }, location: sourceLocation(appFile, 5, 20) },
      { kind: "static", name: "paeg", reference: { scope: "global" }, location: sourceLocation(appFile, 5, 25) },
      { kind: "static", name: "button", reference: { scope: "module", import: headerImport }, location: sourceLocation(appFile, 6, 24) },
      {
        kind: "dynamic",
        expression: "header[variant]",
        pattern: { parts: [{ kind: "unknown" }] },
        reference: { scope: "module", import: headerImport },
        candidates: [],
        reason: "La valeur de variant n’est pas connue statiquement.",
        location: sourceLocation(appFile, 7, 21),
      },
      {
        kind: "dynamic",
        expression: "`button--${variant}`",
        pattern: { parts: [{ kind: "literal", value: "button--" }, { kind: "unknown" }] },
        reference: { scope: "global" },
        candidates: [],
        reason: "Le préfixe est connu, mais variant vient d’une prop.",
        location: sourceLocation(appFile, 8, 22),
      },
      { kind: "static", name: "ghost", reference: { scope: "module", import: unknownImport }, location: sourceLocation(appFile, 9, 23) },
    ],
    warnings: [{ stage: "jsx", code: "unresolved-style-import", reason: unknownImport.reason, location: unknownImport.location, affectedScopes: [{ scope: "project" }] }],
  },
  warnings: exampleProject.warnings,
} satisfies AnalysisInput;

export const exampleReport = {
  schemaVersion: 1,
  completeness: "partial",
  diagnostics: [
    {
      category: "unresolved-import",
      confidence: "low",
      reason: unknownImport.reason,
      location: unknownImport.location,
      candidates: [],
    },
    {
      category: "undefined-class",
      confidence: "medium",
      reason: "Aucune définition globale connue de paeg ; l’import inconnu limite la certitude.",
      symbol: { scope: "global", name: "paeg" },
      location: sourceLocation(appFile, 5, 25),
      candidates: [{ symbol: page, location: sourceLocation(globalFile, 1, 1), confidence: "medium", reason: "Nom proche de paeg." }],
    },
    {
      category: "dynamic-usage",
      confidence: "low",
      reason: "La clé du module dépend de variant ; aucune absence d’usage ne peut être déduite.",
      location: sourceLocation(appFile, 7, 21),
      candidates: [{ symbol: headerButton, location: sourceLocation(headerFile, 1, 1), confidence: "low", reason: "Classe du module référencé, clé inconnue." }],
    },
    {
      category: "unused-class",
      confidence: "low",
      reason: "Aucun usage connu de Footer.button ; l’import inconnu empêche une conclusion certaine.",
      symbol: footerButton,
      location: sourceLocation(footerFile, 1, 1),
      candidates: [],
    },
  ],
  warnings: exampleInput.jsx.warnings,
} satisfies AnalysisReport;
