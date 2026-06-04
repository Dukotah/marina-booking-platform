<?php
/**
 * Built Rite Marine — theme functions.
 *
 * Lean, one-page "business card" theme for Shannon Trent's boat mechanic
 * business in Sonoma County, CA. All marketing content (phone, services,
 * about, service area, hours) is editable from Appearance → Customize so the
 * site can be handed off and updated with no code.
 *
 * @package BuiltRiteMarine
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'BRM_VERSION', '1.0.0' );

/**
 * Theme setup.
 */
function brm_setup() {
	load_theme_textdomain( 'built-rite-marine', get_template_directory() . '/languages' );

	add_theme_support( 'title-tag' );
	add_theme_support( 'automatic-feed-links' );
	add_theme_support( 'html5', array( 'search-form', 'comment-form', 'comment-list', 'gallery', 'caption', 'style', 'script' ) );
	add_theme_support( 'custom-logo', array(
		'height'      => 80,
		'width'       => 320,
		'flex-height' => true,
		'flex-width'  => true,
	) );
	add_theme_support( 'responsive-embeds' );

	// Single-location one-pager: a primary menu is optional. The theme falls
	// back to anchor links to the on-page sections when no menu is assigned.
	register_nav_menus( array(
		'primary' => __( 'Primary Menu', 'built-rite-marine' ),
	) );
}
add_action( 'after_setup_theme', 'brm_setup' );

/**
 * Enqueue styles and scripts.
 */
function brm_assets() {
	// Industrial display type for the rugged/craftsman feel. Body uses a system
	// stack to stay fast (no second web font, no layout shift).
	wp_enqueue_style(
		'brm-fonts',
		'https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&display=swap',
		array(),
		null
	);

	wp_enqueue_style( 'brm-style', get_stylesheet_uri(), array( 'brm-fonts' ), BRM_VERSION );

	wp_enqueue_script(
		'brm-main',
		get_template_directory_uri() . '/assets/js/main.js',
		array(),
		BRM_VERSION,
		true
	);
}
add_action( 'wp_enqueue_scripts', 'brm_assets' );

/**
 * Preconnect to Google Fonts for a touch more speed.
 */
function brm_resource_hints( $hints, $relation_type ) {
	if ( 'preconnect' === $relation_type ) {
		$hints[] = array( 'href' => 'https://fonts.gstatic.com', 'crossorigin' );
	}
	return $hints;
}
add_filter( 'wp_resource_hints', 'brm_resource_hints', 10, 2 );

require get_template_directory() . '/inc/helpers.php';
require get_template_directory() . '/inc/customizer.php';
require get_template_directory() . '/inc/schema.php';
require get_template_directory() . '/inc/contact-form.php';
