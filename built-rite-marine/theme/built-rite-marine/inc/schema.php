<?php
/**
 * SEO: LocalBusiness JSON-LD + Open Graph.
 *
 * Built Rite Marine has no online presence today. Structured data gives Google
 * the name, phone, and service area in a machine-readable form so the business
 * can start showing up in search.
 *
 * @package BuiltRiteMarine
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Output LocalBusiness structured data in the head (front page only).
 */
function brm_json_ld() {
	if ( ! is_front_page() ) {
		return;
	}

	$data = array(
		'@context'    => 'https://schema.org',
		'@type'       => 'AutoRepair',
		'name'        => get_bloginfo( 'name' ),
		'description' => brm_get( 'tagline' ),
		'url'         => home_url( '/' ),
		'areaServed'  => array(
			'@type' => 'AdministrativeArea',
			'name'  => 'Sonoma County, California',
		),
		'address'     => array(
			'@type'           => 'PostalAddress',
			'addressRegion'   => 'CA',
			'addressCountry'  => 'US',
			'addressLocality' => 'Sonoma County',
		),
		'knowsAbout'  => array( 'Boat repair', 'Marine engine repair', 'Outboard motor service', 'Inboard engine repair', 'Boat winterization' ),
	);

	$digits = brm_phone_digits();
	if ( $digits ) {
		$data['telephone'] = '+1' . $digits;
	}

	$email = brm_get( 'email' );
	if ( $email ) {
		$data['email'] = $email;
	}

	if ( has_custom_logo() ) {
		$logo_id = get_theme_mod( 'custom_logo' );
		$logo    = wp_get_attachment_image_url( $logo_id, 'full' );
		if ( $logo ) {
			$data['logo']  = $logo;
			$data['image'] = $logo;
		}
	}

	echo "\n<script type=\"application/ld+json\">" . wp_json_encode( $data ) . "</script>\n";
}
add_action( 'wp_head', 'brm_json_ld' );

/**
 * Minimal Open Graph tags for clean link sharing (texts, Facebook, etc.).
 */
function brm_open_graph() {
	if ( ! is_front_page() ) {
		return;
	}
	$title = get_bloginfo( 'name' );
	$desc  = brm_get( 'tagline' );
	printf( '<meta property="og:type" content="website" />' . "\n" );
	printf( '<meta property="og:title" content="%s" />' . "\n", esc_attr( $title ) );
	printf( '<meta property="og:description" content="%s" />' . "\n", esc_attr( $desc ) );
	printf( '<meta property="og:url" content="%s" />' . "\n", esc_url( home_url( '/' ) ) );
	printf( '<meta name="description" content="%s" />' . "\n", esc_attr( $desc ) );
	printf( '<meta name="twitter:card" content="summary" />' . "\n" );
}
add_action( 'wp_head', 'brm_open_graph', 5 );
