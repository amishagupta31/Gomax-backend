import { Link } from 'react-router';
import { api } from '../api';
import { ErrorBox, initials, Loading, n, useLoad } from '../ui';

// D6a / M5: L1–L4 under one applicator with the runs they earned from each person.
// Admin only — the app never shows levels.
type Person = { id: string; name: string; mobile: string; parentId: string; runsToRoot: number; scanning: boolean };
export type Tree = { levels: { level: number; people: Person[] }[] };

export function useTree(id: string) {
  return useLoad<Tree>(() => api.get(`/applicators/${id}/tree`), [id]);
}

export const treeStats = (tree: Tree) => ({
  total: tree.levels.reduce((s, l) => s + l.people.length, 0),
  runs: tree.levels.reduce((s, l) => s + l.people.reduce((x, p) => x + p.runsToRoot, 0), 0),
  l1: tree.levels[0]?.people.length ?? 0,
  l1Scanning: tree.levels[0]?.people.filter((p) => p.scanning).length ?? 0,
});

/** Indented list (works on desktop and phone): each person under the one who invited them. */
export function TreeList({ rootId, rootName, tree }: { rootId: string; rootName: string; tree: Tree }) {
  const all = tree.levels.flatMap((l) => l.people.map((p) => ({ ...p, level: l.level })));
  const kids = (id: string) => all.filter((p) => p.parentId === id);
  const Node = ({ p }: { p: (typeof all)[number] }) => (
    <li>
      <Link to={`/applicators/${p.id}`} className="row g10" style={{ padding: '6px 8px', borderRadius: 10, border: '1px solid var(--border)', background: '#fff', margin: '6px 0' }}>
        <span className="pill" style={{ padding: '0 7px' }}>
          L{p.level}
        </span>
        <span className="avatar sm">{initials(p.name)}</span>
        <span className="grow">
          <span className="t-13 w6" style={{ display: 'block' }}>
            {p.name}
          </span>
          <span className="t-12 c-sec">{p.scanning ? 'Scanning' : 'Not scanned yet'}</span>
        </span>
        <span className="t-12 w6" style={{ color: 'var(--gift-text)' }}>
          +{n(p.runsToRoot)} runs
        </span>
      </Link>
      {kids(p.id).length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, paddingLeft: 22, borderLeft: '1.5px solid var(--border-line)' }}>
          {kids(p.id).map((k) => (
            <Node key={k.id} p={k} />
          ))}
        </ul>
      )}
    </li>
  );
  if (!all.length) return <p className="t-13 c-sec">Nobody has joined with {rootName.split(' ')[0]}’s code yet.</p>;
  return (
    <div>
      <div className="row g10" style={{ background: 'var(--navy-900)', color: '#fff', borderRadius: 12, padding: '10px 14px', display: 'inline-flex' }}>
        <span className="avatar sm">{initials(rootName)}</span>
        <b>{rootName}</b>
      </div>
      <ul style={{ listStyle: 'none', margin: 0, paddingLeft: 22, borderLeft: '1.5px solid var(--border-line)' }}>
        {kids(rootId).map((k) => (
          <Node key={k.id} p={k} />
        ))}
      </ul>
    </div>
  );
}

export function LevelTable({ tree }: { tree: Tree }) {
  const s = treeStats(tree);
  return (
    <div className="table-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>Level</th>
            <th className="num">People</th>
            <th className="num">Runs</th>
          </tr>
        </thead>
        <tbody>
          {[1, 2, 3, 4].map((lv) => {
            const l = tree.levels.find((x) => x.level === lv);
            return (
              <tr key={lv}>
                <td>
                  <span className={`pill ${lv === 1 ? 'pri' : ''}`}>L{lv}</span>
                </td>
                <td className="num">{l?.people.length ?? 0}</td>
                <td className="num">{n(l?.people.reduce((x, p) => x + p.runsToRoot, 0) ?? 0)}</td>
              </tr>
            );
          })}
          <tr>
            <td className="w7">Total</td>
            <td className="num w7">{s.total}</td>
            <td className="num w7">{n(s.runs)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function TreeCard({ id, name }: { id: string; name: string }) {
  const tree = useTree(id);
  if (tree.error) return <ErrorBox error={tree.error} retry={tree.reload} />;
  if (!tree.data) return <Loading />;
  return <TreeList rootId={id} rootName={name} tree={tree.data} />;
}
