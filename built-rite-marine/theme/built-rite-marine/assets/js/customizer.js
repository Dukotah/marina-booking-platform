/**
 * Customizer live preview for postMessage settings.
 */
( function ( $ ) {
	'use strict';

	wp.customize( 'brm_hero_kicker', function ( value ) {
		value.bind( function ( to ) {
			$( '.hero .eyebrow' ).text( to );
		} );
	} );

	wp.customize( 'brm_tagline', function ( value ) {
		value.bind( function ( to ) {
			$( '.hero__tagline' ).text( to );
		} );
	} );
}( jQuery ) );
