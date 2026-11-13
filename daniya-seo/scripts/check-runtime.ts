import process from 'node:process';

const majorVersion = Number(process.versions.node.split('.')[0]);

if (majorVersion !== 24) {
  process.stderr.write(`Expected Node.js 24.x, received ${process.versions.node}.\n`);
  process.exit(1);
}

process.stdout.write(`Runtime OK: Node.js ${process.versions.node}\n`);
