Leaflet 1.9.4, unmodified `dist/leaflet.js` and `dist/leaflet.css` from the npm package
`leaflet@1.9.4` (integrity `sha512-nxS1ynzJOmOlHp+iL3FyWqK89GtNL8U8rvlMOsQdTTssxZwCXh8N2NB3GDQOL+YR3XnWyZAxwQixURb+FA74PA==`),
BSD-2-Clause (see `LICENSE`).

`images/` is not vendored: the app uses no layers control and no default marker icon, so the
`url(images/...)` rules in the stylesheet never match. Add the folder if either is introduced.

To upgrade: `npm pack leaflet@<version>`, replace the two files and `LICENSE`, update the
version and integrity above, then run `npm run shell:hash`.
