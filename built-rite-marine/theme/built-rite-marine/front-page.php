<?php
/**
 * Front page — the single-page Built Rite Marine site.
 *
 * @package BuiltRiteMarine
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

get_header();
get_template_part( 'template-parts/home' );
get_footer();
