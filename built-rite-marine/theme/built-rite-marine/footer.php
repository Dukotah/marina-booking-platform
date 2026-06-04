<?php
/**
 * Footer.
 *
 * @package BuiltRiteMarine
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}
?>
</main><!-- #main -->

<footer class="site-footer">
	<div class="wrap site-footer__inner">
		<div>
			<span class="site-footer__brand">
				<?php echo esc_html( get_bloginfo( 'name' ) ); ?>
			</span>
			<br />
			<small><?php echo esc_html( brm_get( 'footer_note' ) ); ?></small>
		</div>
		<div>
			<small>
				&copy; <?php echo esc_html( gmdate( 'Y' ) ); ?>
				<?php echo esc_html( get_bloginfo( 'name' ) ); ?>.
				<?php esc_html_e( 'All rights reserved.', 'built-rite-marine' ); ?>
			</small>
		</div>
	</div>
</footer>

<?php wp_footer(); ?>
</body>
</html>
