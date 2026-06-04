/**
 * Built Rite Marine — front-end behavior.
 * Mobile nav toggle + close-on-link-tap. No dependencies.
 */
( function () {
	'use strict';

	var nav = document.querySelector( '.nav' );
	var toggle = document.querySelector( '.nav-toggle' );

	if ( nav && toggle ) {
		toggle.addEventListener( 'click', function () {
			var open = nav.classList.toggle( 'is-open' );
			toggle.setAttribute( 'aria-expanded', open ? 'true' : 'false' );
		} );

		// Close the menu after tapping an anchor link (mobile one-pager).
		nav.addEventListener( 'click', function ( e ) {
			var link = e.target.closest( 'a' );
			if ( link && nav.classList.contains( 'is-open' ) ) {
				nav.classList.remove( 'is-open' );
				toggle.setAttribute( 'aria-expanded', 'false' );
			}
		} );
	}
}() );
