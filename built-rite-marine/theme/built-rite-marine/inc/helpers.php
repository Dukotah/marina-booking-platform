<?php
/**
 * Content helpers + editable defaults.
 *
 * Every piece of marketing copy has a placeholder default here so the theme
 * looks complete out of the box. Real values are entered in the Customizer and
 * override these. Placeholders are clearly believable but must be confirmed
 * with Shannon before launch (see README → "Collect from Shannon").
 *
 * @package BuiltRiteMarine
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Central registry of defaults. Single source of truth for the Customizer
 * and the templates.
 *
 * @return array<string,string>
 */
function brm_defaults() {
	return array(
		'phone'          => '(707) XXX-XXXX',
		'email'          => '',
		'hero_kicker'    => 'Sonoma County Boat Mechanic',
		'tagline'        => 'Honest, old-school marine repair — done right the first time.',
		'trust_points'   => "Decades of experience\nStraight talk, fair prices\nSonoma County local",
		'services_intro' => 'From a no-start at the ramp to full off-season prep, Shannon keeps your boat running right.',
		'services'       => "Inboard & Outboard Repair | Diagnostics, tune-ups, and repairs on gas inboard and outboard engines.\nWinterization & Storage Prep | Protect your boat through the off-season with complete winterization service.\nEngine Tune-Ups | Carburetor, ignition, and plug service to keep your motor running strong.\nLower Unit & Drive Service | Gearcase, water pump, and outdrive maintenance and repair.\nElectrical & Wiring | Batteries, charging systems, and onboard electrical troubleshooting.\nRoutine Maintenance | Oil, filters, fluids, and seasonal check-ups to prevent breakdowns.",
		'about_heading'  => 'Built on Decades of Hard-Earned Know-How',
		'about_text'     => "Shannon Trent has spent his career with his hands on engines — the kind of mechanic who can hear what's wrong before he picks up a wrench. By day he keeps the equipment running at Jordan Vineyard & Winery in Windsor; on the side he brings that same care to boats across Sonoma County.\n\nNo upsells, no runaround — just honest work and a straight answer. If it's not worth fixing, he'll tell you. If it can be saved, he'll do it right.",
		'about_signature'=> 'Shannon Trent, Owner',
		'why_points'     => "Old-school craftsmanship\nUpfront, honest pricing\nWork done right the first time\nLocal — knows the lakes and rivers here",
		'area_heading'   => 'Serving All of Sonoma County',
		'area_text'      => 'Based in Sonoma County and covering the lakes, rivers, and coast nearby. Not sure if you\'re in range? Give a call — if Shannon can get to you, he will.',
		'area_towns'     => "Santa Rosa\nHealdsburg\nWindsor\nSonoma\nPetaluma\nSebastopol\nCloverdale\nRohnert Park\nLake Sonoma\nRussian River",
		'area_note'      => 'Mobile service available throughout the county — he comes to your boat.',
		'hours'          => 'By appointment — calls returned same day',
		'cta_heading'    => 'Got a Boat That Needs Work?',
		'cta_text'       => 'Call or text Shannon directly. Tell him what your boat is doing and he\'ll let you know how he can help.',
		'form_recipient' => '',
		'footer_note'    => 'Independent marine repair · Sonoma County, California',
	);
}

/**
 * Get a single content value (Customizer value, falling back to default).
 *
 * @param string $key Setting key (without the brm_ prefix).
 * @return string
 */
function brm_get( $key ) {
	$defaults = brm_defaults();
	$default  = isset( $defaults[ $key ] ) ? $defaults[ $key ] : '';
	return (string) get_theme_mod( 'brm_' . $key, $default );
}

/**
 * Digits-only phone for tel: links.
 *
 * @return string e.g. "7075551234" (empty-ish if placeholder).
 */
function brm_phone_digits() {
	return preg_replace( '/[^0-9]/', '', brm_get( 'phone' ) );
}

/**
 * Render a click-to-call link.
 *
 * @param string $class CSS classes for the anchor.
 * @param string $label Optional override label (defaults to the display phone).
 * @return string HTML.
 */
function brm_call_link( $class = '', $label = '' ) {
	$display = brm_get( 'phone' );
	$digits  = brm_phone_digits();
	$label   = '' === $label ? $display : $label;
	$href    = $digits ? 'tel:+1' . $digits : '#contact';
	return sprintf(
		'<a class="%1$s" href="%2$s">%3$s</a>',
		esc_attr( $class ),
		esc_attr( $href ),
		esc_html( $label )
	);
}

/**
 * Parse a "Title | Description" multiline string into service rows.
 *
 * @return array<int,array{title:string,desc:string}>
 */
function brm_services_list() {
	$raw   = brm_get( 'services' );
	$lines = preg_split( '/\r\n|\r|\n/', $raw );
	$out   = array();
	foreach ( $lines as $line ) {
		$line = trim( $line );
		if ( '' === $line ) {
			continue;
		}
		$parts = array_map( 'trim', explode( '|', $line, 2 ) );
		$out[] = array(
			'title' => $parts[0],
			'desc'  => isset( $parts[1] ) ? $parts[1] : '',
		);
	}
	return $out;
}

/**
 * Parse a simple newline list into trimmed items.
 *
 * @param string $key Setting key.
 * @return string[]
 */
function brm_lines( $key ) {
	$lines = preg_split( '/\r\n|\r|\n/', brm_get( $key ) );
	return array_values( array_filter( array_map( 'trim', $lines ), 'strlen' ) );
}

/**
 * Default on-page anchor nav for the one-pager (used when no menu is assigned).
 */
function brm_default_nav() {
	$items = array(
		'#services' => __( 'Services', 'built-rite-marine' ),
		'#about'    => __( 'About', 'built-rite-marine' ),
		'#area'     => __( 'Service Area', 'built-rite-marine' ),
		'#contact'  => __( 'Contact', 'built-rite-marine' ),
	);
	echo '<ul id="primary-menu" class="nav__links">';
	foreach ( $items as $href => $label ) {
		printf( '<li><a href="%s">%s</a></li>', esc_attr( $href ), esc_html( $label ) );
	}
	echo '</ul>';
}
