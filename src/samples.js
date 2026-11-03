// Original short descriptions for an explicitly labelled offline preview, not HN data.
const samples = [
  ['Dyson sphere', 'Space & physics', 'What if a civilization could capture the energy of an entire star? A Dyson sphere is a hypothetical structure surrounding a star to harvest its power. The idea is less about a solid shell and more about a vast swarm of independent orbiting collectors.', 'orbit'],
  ['The Mother of All Demos', 'Computing history', 'In 1968, Douglas Engelbart demonstrated a computer mouse, hypertext, video conferencing, and collaborative editing in a single presentation. Much of what feels ordinary on a computer today was an astonishing glimpse of the future.', 'terminal'],
  ['Fermi paradox', 'Space & physics', 'The universe is enormous, ancient, and filled with planets. So where is everybody? The Fermi paradox explores the apparent tension between the possibility of abundant extraterrestrial life and the lack of clear evidence for it.', null],
  ['Lindy effect', 'Ideas & society', 'For some things that do not age biologically, surviving longer may suggest a longer future. The Lindy effect applies this idea to books, technologies, and cultural traditions. It is a useful lens, though not a universal law.', null],
  ['Antikythera mechanism', 'History & engineering', 'Recovered from a Greek shipwreck, this ancient geared device modelled astronomical cycles. Its surviving bronze fragments reveal a remarkable level of mechanical sophistication more than two thousand years ago.', 'gears'],
  ['Game of Life', 'Mathematics', 'A grid of cells follows four simple rules about birth, survival, and death. From those local rules emerge moving patterns, oscillators, and even universal computation. John Conway’s cellular automaton makes complexity visible.', 'life'],
  ['Bikeshedding', 'Ideas & society', 'Why can a meeting spend more time choosing a bike shed’s paint than discussing a nuclear reactor? Parkinson’s law of triviality describes how groups gravitate toward easy, familiar details while difficult decisions receive less attention.', null],
  ['Gödel’s incompleteness theorems', 'Mathematics', 'There are limits to what a formal mathematical system can prove about itself. Kurt Gödel showed that sufficiently expressive, consistent systems contain statements that cannot be proved within those systems.', null],
  ['Voyager Golden Record', 'Space & physics', 'A greeting pressed into a gold-plated copper disc travels aboard each Voyager spacecraft. The records carry sounds, music, and images of Earth, selected as a portrait of our planet for anyone who might someday find them.', 'record'],
  ['Unix philosophy', 'Computing history', 'Build small tools that do one thing well, then make them work together. The Unix philosophy is an approach to software design that favours simple interfaces and composition over sprawling, all-purpose programs.', 'terminal'],
  ['Survivorship bias', 'Ideas & society', 'The examples we can see are often the ones that made it through a selection process. Survivorship bias occurs when we draw conclusions from those survivors while overlooking the missing cases that might change the story.', null],
  ['Braess’s paradox', 'Mathematics', 'Adding a road can sometimes make everyone’s journey slower. Braess’s paradox shows how individually sensible route choices can create a worse outcome for the whole network, a result with applications beyond traffic.', null],
];
const aliases = { 'Game of Life': "Conway's Game of Life", 'Bikeshedding': "Parkinson's law of triviality", 'Gödel’s incompleteness theorems': "Gödel's incompleteness theorems" };
export const SAMPLE_ARTICLES = samples.map(([title, description, extract, illustration]) => ({
  id: `en:${aliases[title] || title}`, title: aliases[title] || title, lang: 'en',
  url: `https://en.wikipedia.org/wiki/${encodeURIComponent((aliases[title] || title).replaceAll(' ', '_'))}`,
  description, extract, illustration, mentions: [], sample: true,
}));
