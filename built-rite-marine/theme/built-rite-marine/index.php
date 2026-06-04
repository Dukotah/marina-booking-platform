<?php
/**
 * Fallback template.
 *
 * This is a single-page "business card" theme. On the home/front view it renders
 * the full one-page layout even if a static front page hasn't been configured
 * yet, so the site looks right immediately after activation. For any other
 * query it shows a minimal content fallback.
 *
 * @package BuiltRiteMarine
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

get_header();

if ( is_front_page() || is_home() ) {
	get_template_part( 'template-parts/home' );
} else {
	echo '<div class="section section--navy"><div class="wrap">';
	if ( have_posts() ) {
		while ( have_posts() ) {
			the_post();
			echo '<article>';
			the_title( '<h1 class="section-title">', '</h1>' );
			the_content();
			echo '</article>';
		}
	} else {
		echo '<h1 class="section-title">' . esc_html__( 'Nothing here', 'built-rite-marine' ) . '</h1>';
		echo '<p><a class="btn btn--call" href="' . esc_url( home_url( '/' ) ) . '">' . esc_html__( 'Back home', 'built-rite-marine' ) . '</a></p>';
	}
	echo '</div></div>';
}

get_footer();
